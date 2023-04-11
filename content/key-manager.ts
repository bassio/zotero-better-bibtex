Components.utils.import('resource://gre/modules/Services.jsm')

import ETA from 'node-eta'

import { kuroshiro } from './key-manager/japanese'
import { jieba } from './key-manager/chinese'

import { Scheduler } from './scheduler'
import { log } from './logger'
import { flash } from './flash'
import { Events, itemsChanged } from './events'
import { fetchAsync as fetchInspireHEP } from './inspire-hep'
import * as Extra from './extra'
import { $and, Query } from './db/loki'
import { excelColumn } from './text'

import * as ZoteroDB from './db/zotero'

import { getItemsAsync } from './get-items-async'

import { Preference } from './prefs'
import { Formatter } from './key-manager/formatter'
import { DB } from './db/main'
import { DB as Cache } from './db/cache'

import { patch as $patch$ } from './monkey-patch'

import { sprintf } from 'sprintf-js'

import * as l10n from './l10n'

type CitekeySearchRecord = { itemID: number, libraryID: number, itemKey: string, citekey: string }

export class KeyManager {
  public keys: any
  public query: {
    field: { extra?: number, title?: number }
    type: {
      note?: number
      attachment?: number
      annotation?: number
    }
  }
  public autopin: Scheduler = new Scheduler('autoPinDelay', 1000) // eslint-disable-line no-magic-numbers

  private regenerate: number[]
  private started = false

  private getField(item: { getField: ((str: string) => string)}, field: string): string {
    try {
      return item.getField(field) || ''
    }
    catch (err) {
      return ''
    }
  }

  public async set(): Promise<void> {
    const ids = this.expandSelection('selected')
    if (ids.length !== 1) return alert(l10n.localize('Citekey.set.toomany'))

    Cache.remove(ids, `setting key for ${ids}`)
    const existingKey = this.get(ids[0]).citekey
    const citationKey = prompt(l10n.localize('Citekey.set.change'), existingKey) || existingKey
    if (citationKey === existingKey) return

    const item = await getItemsAsync(ids[0])
    item.setField('extra', Extra.set(item.getField('extra'), { citationKey }))
    await item.saveTx() // this should cause an update and key registration
  }

  public async pin(ids: 'selected' | number | number[], inspireHEP = false): Promise<void> {
    ids = this.expandSelection(ids)

    for (const item of await getItemsAsync(ids)) {
      if (item.isFeedItem || !item.isRegularItem()) continue

      const extra = this.getField(item, 'extra')
      const parsed = Extra.get(extra, 'zotero')
      let citationKey: string = null

      if (inspireHEP) {
        citationKey = await fetchInspireHEP(item)
        if (!citationKey || parsed.extraFields.citationKey === citationKey) continue
      }
      else {
        if (parsed.extraFields.citationKey) continue

        citationKey = this.get(item.id).citekey || this.update(item)
      }

      item.setField('extra', Extra.set(extra, { citationKey }))
      await item.saveTx() // this should cause an update and key registration
    }
  }

  public async unpin(ids: 'selected' | number | number[]): Promise<void> {
    ids = this.expandSelection(ids)

    for (const item of await getItemsAsync(ids)) {
      if (item.isFeedItem || !item.isRegularItem()) continue

      const parsed = Extra.get(item.getField('extra'), 'zotero', { citationKey: true })
      if (!parsed.extraFields.citationKey) continue

      item.setField('extra', parsed.extra) // citekey is stripped here but will be regenerated by the notifier
      item.saveTx()
    }

  }

  public async refresh(ids: 'selected' | number | number[], manual = false): Promise<void> {
    ids = this.expandSelection(ids)

    Cache.remove(ids, `refreshing keys for ${ids}`)

    const warnAt = manual ? Preference.warnBulkModify : 0
    if (warnAt > 0 && ids.length > warnAt) {
      const affected = this.keys.find({ $and: [{ itemID: { $in: ids } }, { pinned: { $eq: false } } ] }).length
      if (affected > warnAt) {
        const params = { treshold: warnAt, response: null }
        Zotero.BetterBibTeX.openDialog('chrome://zotero-better-bibtex/content/bulk-keys-confirm.xul', '', 'chrome,dialog,centerscreen,modal', params)
        switch (params.response) {
          case 'ok':
            break
          case 'whatever':
            Preference.warnBulkModify = 0
            break
          default:
            return
        }
      }
    }

    const updates = []
    for (const item of await getItemsAsync(ids)) {
      if (item.isFeedItem || !item.isRegularItem()) continue

      const extra = item.getField('extra')

      let citekey = Extra.get(extra, 'zotero', { citationKey: true }).extraFields.citationKey
      if (citekey) continue // pinned, leave it alone

      this.update(item)

      // remove the new citekey from the aliases if present
      citekey = this.get(item.id).citekey
      const aliases = Extra.get(extra, 'zotero', { aliases: true })
      if (aliases.extraFields.aliases.includes(citekey)) {
        aliases.extraFields.aliases = aliases.extraFields.aliases.filter(alias => alias !== citekey)

        if (aliases.extraFields.aliases.length) {
          item.setField('extra', Extra.set(aliases.extra, { aliases: aliases.extraFields.aliases }))
        }
        else {
          item.setField('extra', aliases.extra)
        }
        await item.saveTx()
      }
      else {
        updates.push(item)
      }
    }

    if (updates.length) itemsChanged(updates)
  }

  public async init(): Promise<void> {
    log.debug('keymanager.init: kuroshiro/jieba')
    await kuroshiro.init()
    jieba.init()

    log.debug('keymanager.init: get keys')
    this.keys = DB.getCollection('citekey')

    this.query = {
      field: {},
      type: {},
    }

    log.debug('keymanager.init: pre-fetching types/fields')
    for (const type of await ZoteroDB.queryAsync('select itemTypeID, typeName from itemTypes')) { // 1 = attachment, 14 = note
      this.query.type[type.typeName] = type.itemTypeID
    }

    for (const field of await ZoteroDB.queryAsync('select fieldID, fieldName from fields')) {
      this.query.field[field.fieldName] = field.fieldID
    }

    log.debug('keymanager.init: compiling', Preference.citekeyFormat)
    Formatter.update([Preference.citekeyFormat])
    log.debug('keymanager.init: done')
  }

  public async start(): Promise<void> {
    await this.rescan()

    let search = Preference.citekeySearch
    if (search) {
      try {
        const path = OS.Path.join(Zotero.DataDirectory.dir, 'better-bibtex-search.sqlite')
        await Zotero.DB.queryAsync(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS betterbibtexsearch`)
      }
      catch (err) {
        log.error('failed to attach the search database:', err)
        flash('Error loading citekey search database, citekey search is disabled')
        search = false
      }
    }
    if (search) {
      /*
      // 1829
      try {
        // no other way to detect column existence on attached databases
        await Zotero.DB.valueQueryAsync('SELECT libraryID FROM betterbibtexsearch.citekeys LIMIT 1')
      }
      catch (err) {
        log.error(`dropping betterbibtexsearch.citekeys, assuming libraryID does not exist: ${err}`)
        await Zotero.DB.queryAsync('DROP TABLE IF EXISTS betterbibtexsearch.citekeys')
      }
      */
      await Zotero.DB.queryAsync('CREATE TABLE IF NOT EXISTS betterbibtexsearch.citekeys (itemID PRIMARY KEY, libraryID, itemKey, citekey)')

      const match: Record<string, CitekeySearchRecord> = this.keys.data
        .reduce((acc: Record<string, CitekeySearchRecord>, k: CitekeySearchRecord) => {
          acc[`${k.itemID}\t${k.libraryID}\t${k.itemKey}\t${k.citekey}`] = k
          return acc
        }, {})

      const remove: string[] = []
      for (const row of await Zotero.DB.queryAsync('SELECT itemID, libraryID, itemKey, citekey FROM betterbibtexsearch.citekeys')) {
        const key = `${row.itemID}\t${row.libraryID}\t${row.itemKey}\t${row.citekey}`
        if (match[key]) {
          delete match[key]
        }
        else {
          remove.push(`${row.itemID}`)
        }
      }
      const insert = Object.values(match)

      if (remove.length + insert.length) {
        await Zotero.DB.executeTransaction(async () => {
          if (remove.length) await Zotero.DB.queryAsync(`DELETE FROM betterbibtexsearch.citekeys WHERE itemID in (${remove.join(',')})`)

          if (insert.length) {
            for (const row of insert) {
              await ZoteroDB.queryAsync('INSERT INTO betterbibtexsearch.citekeys (itemID, libraryID, itemKey, citekey) VALUES (?, ?, ?, ?)', [ row.itemID, row.libraryID, row.itemKey, row.citekey ])
            }
          }
        })
      }

      const citekeySearchCondition = {
        name: 'citationKey',
        operators: {
          is: true,
          isNot: true,
          contains: true,
          doesNotContain: true,
        },
        table: 'betterbibtexsearch.citekeys',
        field: 'citekey',
        localized: 'Citation Key',
      }
      $patch$(Zotero.Search.prototype, 'addCondition', original => function addCondition(condition: string, operator: any, value: any, _required: any) {
        // detect a quick search being set up
        if (condition.match(/^quicksearch/)) this.__add_bbt_citekey = true
        // creator is always added in a quick search so use it as a trigger
        if (condition === 'creator' && this.__add_bbt_citekey) {
          original.call(this, citekeySearchCondition.name, operator, value, false)
          delete this.__add_bbt_citekey
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
      $patch$(Zotero.SearchConditions, 'hasOperator', original => function hasOperator(condition: string, operator: string | number) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (condition === citekeySearchCondition.name) return citekeySearchCondition.operators[operator]
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
      $patch$(Zotero.SearchConditions, 'get', original => function get(condition: string) {
        if (condition === citekeySearchCondition.name) return citekeySearchCondition
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
      $patch$(Zotero.SearchConditions, 'getStandardConditions', original => function getStandardConditions() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments).concat({
          name: citekeySearchCondition.name,
          localized: citekeySearchCondition.localized,
          operators: citekeySearchCondition.operators,
        }).sort((a: { localized: string }, b: { localized: any }) => a.localized.localeCompare(b.localized))
      })
      $patch$(Zotero.SearchConditions, 'getLocalizedName', original => function getLocalizedName(str: string) {
        if (str === citekeySearchCondition.name) return citekeySearchCondition.localized
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
    }

    Events.on('preference-changed', pref => {
      if (['autoAbbrevStyle', 'citekeyFormat', 'citekeyFold', 'citekeyUnsafeChars', 'skipWords'].includes(pref)) {
        Formatter.update([Preference.citekeyFormat])
      }
    })

    this.keys.on(['insert', 'update'], async (citekey: { itemID: number, itemKey: any, citekey: any, pinned: any }) => {
      if (Preference.citekeySearch) {
        await ZoteroDB.queryAsync('INSERT OR REPLACE INTO betterbibtexsearch.citekeys (itemID, itemKey, citekey) VALUES (?, ?, ?)', [ citekey.itemID, citekey.itemKey, citekey.citekey ])
      }

      // async is just a heap of fun. Who doesn't enjoy a good race condition?
      // https://github.com/retorquere/zotero-better-bibtex/issues/774
      // https://groups.google.com/forum/#!topic/zotero-dev/yGP4uJQCrMc
      await Zotero.Promise.delay(Preference.itemObserverDelay)

      let item
      try {
        item = await Zotero.Items.getAsync(citekey.itemID)
      }
      catch (err) {
        // assume item has been deleted before we could get to it -- did I mention I hate async? I hate async
        log.error('could not load', citekey.itemID, err)
        return
      }

      // update display panes by issuing a fake item-update notification
      Zotero.Notifier.trigger('modify', 'item', [citekey.itemID], { [citekey.itemID]: { bbtCitekeyUpdate: true } })

      if (!citekey.pinned && this.autopin.enabled) {
        this.autopin.schedule(citekey.itemID, () => {
          this.pin([citekey.itemID]).catch(err => log.error('failed to pin', citekey.itemID, ':', err))
        })
      }
      if (citekey.pinned && Preference.keyConflictPolicy === 'change') {
        const conflictQuery: Query = { $and: [
          { itemID: { $ne: item.id } },
          { pinned: { $eq: false } },
          { citekey: { $eq: citekey.citekey } },
        ]}
        if (Preference.keyScope !== 'global')  conflictQuery.$and.push( { libraryID: { $eq: item.libraryID } } )

        for (const conflict of this.keys.find(conflictQuery)) {
          item = await Zotero.Items.getAsync(conflict.itemID)
          this.update(item, conflict)
        }
      }
    })

    this.keys.on('delete', async (citekey: { itemID: any }) => {
      if (Preference.citekeySearch) {
        await ZoteroDB.queryAsync('DELETE FROM betterbibtexsearch.citekeys WHERE itemID = ?', [ citekey.itemID ])
      }
    })

    this.started = true
  }

  public async rescan(clean?: boolean): Promise<void> {
    if (Preference.scrubDatabase) {
      log.debug('scrubbing database')
      this.keys.removeWhere(i => !i.citekey) // 2047

      let errors = 0
      for (const item of this.keys.data) {
        if ('extra' in item) { // 799, tests for existence even if it is empty
          delete item.extra
          this.keys.update(item)
        }

        if (!this.keys.validate(item)) {
          log.error('KeyManager.rescan, scrub error:', item, this.keys.validate.errors)
          errors += 1
        }
      }

      if (errors) alert(`Better BibTeX: ${errors} errors found in the citekey database, please report on the Better BibTeX project site`)
    }

    if (Array.isArray(this.regenerate)) {
      flash('Regeneration still in progress', 'Citation key regeneration is still running')
      return
    }

    this.regenerate = []

    if (clean) this.keys.removeDataOnly()

    const keyLine = /(^|\n)Citation Key\s*:\s*(.+?)(\n|$)/i
    const getKey = (extra: string) => {
      if (!extra) return ''
      const m = keyLine.exec(extra)
      return m ? m[2].trim() : ''
    }

    type DBState = Map<number, { itemKey: string, citationKey: string }>
    const inzdb: DBState = (await ZoteroDB.queryAsync(`
      SELECT item.itemID, item.key, extra.value as extra
      FROM items item

      LEFT JOIN itemData extraField ON extraField.itemID = item.itemID AND extraField.fieldID = ${this.query.field.extra}
      LEFT JOIN itemDataValues extra ON extra.valueID = extraField.valueID

      WHERE item.itemID NOT IN (SELECT itemID FROM deletedItems)
        AND item.itemTypeID NOT IN (${this.query.type.attachment}, ${this.query.type.note}, ${this.query.type.annotation || this.query.type.note})
        AND item.itemID NOT IN (SELECT itemID from feedItems)
    `)).reduce((acc: DBState, item) => {
      acc.set(item.itemID, {
        itemKey: item.key,
        citationKey: getKey(item.extra),
      })
      return acc
    }, new Map)

    const deleted: number[] = []
    for (const bbt of this.keys.data) {
      const zotero = inzdb.get(bbt.itemID)

      if (!zotero) {
        deleted.push(bbt.itemID)
      }
      else if (zotero.citationKey && (!bbt.pinned || bbt.citekey !== zotero.citationKey)) {
        this.keys.update({...bbt, pinned: true, citekey: zotero.citationKey, itemKey: zotero.itemKey })
      }
      else if (!zotero.citationKey && bbt.citekey && bbt.pinned) {
        this.keys.update({...bbt, pinned: false, itemKey: zotero.itemKey})
      }
      else if (!bbt.citekey) { // this should not be possible
        this.regenerate.push(bbt.itemID)
      }

      inzdb.delete(bbt.itemID)
    }

    this.keys.findAndRemove({ itemID: { $in: [...deleted, ...this.regenerate] } })
    this.regenerate.push(...inzdb.keys()) // generate new keys for items that are in the Z db but not in the BBT db

    if (this.regenerate.length) {
      const progressWin = new Zotero.ProgressWindow({ closeOnClick: false })
      progressWin.changeHeadline('Better BibTeX: Assigning citation keys')
      progressWin.addDescription(`Found ${this.regenerate.length} items without a citation key`)
      const icon = `chrome://zotero/skin/treesource-unfiled${Zotero.hiDPI ? '@2x' : ''}.png`
      const progress = new progressWin.ItemProgress(icon, 'Assigning citation keys')
      progressWin.show()

      const eta = new ETA(this.regenerate.length, { autoStart: true })
      for (const itemID of this.regenerate) {
        try {
          this.update(await getItemsAsync(itemID))
        }
        catch (err) {
          log.error('KeyManager.rescan: update', (eta.done as number) + 1, 'failed:', err.message || err, err.stack)
        }

        eta.iterate()

        if ((eta.done % 10) === 1) { // eslint-disable-line no-magic-numbers
          log.debug('keymanager.rescan: regenerated', eta.done)
          // eslint-disable-next-line no-magic-numbers
          progress.setProgress((eta.done * 100) / eta.count)
          progress.setText(eta.format(`${eta.done} / ${eta.count}, {{etah}} remaining`))
        }
      }

      // eslint-disable-next-line no-magic-numbers
      progress.setProgress(100)
      progress.setText('Ready')
      // eslint-disable-next-line no-magic-numbers
      progressWin.startCloseTimer(500)
    }

    this.regenerate = null
  }

  public update(item: ZoteroItem, current?: { pinned: boolean, citekey: string }): string {
    if (item.isFeedItem || !item.isRegularItem()) return null

    current = current || this.keys.findOne($and({ itemID: item.id }))

    const proposed = this.propose(item)

    if (current && (current.pinned || !this.autopin.enabled) && (current.pinned === proposed.pinned) && (current.citekey === proposed.citekey)) return current.citekey

    if (current) {
      current.pinned = proposed.pinned
      current.citekey = proposed.citekey
      this.keys.update(current)
    }
    else {
      this.keys.insert({ itemID: item.id, libraryID: item.libraryID, itemKey: item.key, pinned: proposed.pinned, citekey: proposed.citekey })
    }

    return proposed.citekey
  }

  public remove(ids: number[] | number): void {
    if (!Array.isArray(ids)) ids = [ids]
    this.keys.findAndRemove({ itemID : { $in : ids } })
  }

  public get(itemID: number): { citekey: string, pinned: boolean, retry?: boolean } {
    // I cannot prevent being called before the init is done because Zotero unlocks the UI *way* before I'm getting the
    // go-ahead to *start* my init.
    if (!this.keys || !this.started) return { citekey: '', pinned: false, retry: true }

    const key = (this.keys.findOne($and({ itemID })) as { citekey: string, pinned: boolean })
    if (key) return key
    return { citekey: '', pinned: false, retry: true }
  }

  public propose(item: ZoteroItem, transient: string[] = []): { citekey: string, pinned: boolean } {
    let citekey: string = Extra.get(item.getField('extra') as string, 'zotero', { citationKey: true }).extraFields.citationKey

    if (citekey) return { citekey, pinned: true }

    citekey = Formatter.format(item)

    const conflictQuery: Query = { $and: [ { citekey: { $eq: '' } }, { itemID: { $ne: item.id } } ] }
    if (Preference.keyScope !== 'global') conflictQuery.$and.push({ libraryID: { $eq: item.libraryID } })

    const seen = {}
    // eslint-disable-next-line no-constant-condition
    for (let n = Formatter.postfix.offset; true; n += 1) {
      const postfixed = citekey.replace(Formatter.postfix.marker, () => {
        let postfix = ''
        if (n) {
          const alpha = excelColumn(n)
          postfix = sprintf(Formatter.postfix.template, { a: alpha.toLowerCase(), A: alpha, n })
        }
        // this should never happen, it'd mean the postfix pattern doesn't have placeholders, which should have been caught by parsePattern
        if (seen[postfix]) throw new Error(`${JSON.stringify(Formatter.postfix)} does not generate unique postfixes`)
        seen[postfix] = true
        return postfix
      })

      conflictQuery.$and[0] = { citekey: { $eq: postfixed } }
      const conflict = transient.includes(postfixed) || this.keys.findOne(conflictQuery)
      if (conflict) continue

      return { citekey: postfixed, pinned: false }
    }
  }

  public async tagDuplicates(libraryID: number): Promise<void> {
    const tag = '#duplicate-citation-key'

    const tagged = (await ZoteroDB.queryAsync(`
      SELECT items.itemID
      FROM items
      JOIN itemTags ON itemTags.itemID = items.itemID
      JOIN tags ON tags.tagID = itemTags.tagID
      WHERE (items.libraryID = ? OR 'global' = ?) AND tags.name = ? AND items.itemID NOT IN (select itemID from deletedItems)
    `, [ libraryID, Preference.keyScope, tag ])).map((item: { itemID: number }) => item.itemID)

    const citekeys: {[key: string]: any[]} = {}
    for (const item of this.keys.find(Preference.keyScope === 'global' ? undefined : $and({ libraryID }))) {
      if (!citekeys[item.citekey]) citekeys[item.citekey] = []
      citekeys[item.citekey].push({ itemID: item.itemID, tagged: tagged.includes(item.itemID), duplicate: false })
      if (citekeys[item.citekey].length > 1) citekeys[item.citekey].forEach(i => i.duplicate = true)
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    const mistagged = Object.values(citekeys).reduce((acc, val) => acc.concat(val), []).filter(i => i.tagged !== i.duplicate).map(i => i.itemID)
    for (const item of await getItemsAsync(mistagged)) {
      if (tagged.includes(item.id)) {
        item.removeTag(tag)
      }
      else {
        item.addTag(tag)
      }

      await item.saveTx()
    }
  }

  private expandSelection(ids: 'selected' | number | number[]): number[] {
    if (Array.isArray(ids)) return ids

    if (ids === 'selected') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return Zotero.getActiveZoteroPane().getSelectedItems(true)
      }
      catch (err) { // zoteroPane.getSelectedItems() doesn't test whether there's a selection and errors out if not
        log.error('Could not get selected items:', err)
        return []
      }
    }

    return [ids]
  }
}
