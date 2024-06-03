import { openDB, IDBPDatabase, IDBPTransaction, DBSchema } from 'idb'
import type { Attachment, Item, Note } from '../../gen/typings/serialized-item'
import { print } from '../logger'

type Serialized = Item | Attachment | Note
type Serializer = (item: any) => Serialized

interface Schema extends DBSchema {
  ExportFormat: {
    value: Serialized
    key: number
  }
  metadata: {
    value: { key: string, value: string | number }
    key: string
  }
}

class ExportFormat {
  constructor(private db: IDBPDatabase<Schema>, private serialize: Serializer) {
  }

  public async fill(items: any[]): Promise<void> {
    const tx = this.db.transaction('ExportFormat', 'readwrite')
    const cached = new Set(await tx.store.getAllKeys())
    print(`indexed: filling ${items.filter(item => !item.isFeedItem && item.isRegularItem() && !cached.has(item.id)).length}/${items.length}`)
    await this.store(items.filter(item => !cached.has(item.id)), tx)
  }

  public async get(ids: number[]): Promise<Serialized[]> {
    const tx = this.db.transaction('ExportFormat', 'readonly')
    const items: Serialized[] = await Promise.all(ids.map(id => tx.store.get(id)))
    await tx.done
    return items
  }

  public async store(items: any[], tx?: IDBPTransaction<Schema, ['ExportFormat'], 'readwrite'>): Promise<void> {
    items = items.filter(item => !item.isFeedItem && item.isRegularItem())
    if (!items.length) return
    if (!tx) tx = this.db.transaction('ExportFormat', 'readwrite')
    const puts = items.map(item => tx.store.put(this.serialize(item)))
    await Promise.all([...puts, tx.done])
  }

  public async delete(ids: number[]): Promise<void> {
    const tx = this.db.transaction('ExportFormat', 'readwrite')
    const deletes = ids.map(id => tx.store.delete(id))
    await Promise.all([...deletes, tx.done])
  }
}

export const cache = new class Cache {
  public schema = 4
  private db: IDBPDatabase<Schema>
  public opened = false

  public ExportFormat: ExportFormat

  public async touch(): Promise<void> {
    await this.db.put('metadata', Zotero.Date.dateToSQL(new Date(), true), 'lastUpdated')
  }

  public async open(): Promise<void>
  public async open(serialize: Serializer, lastUpdated: string)
  public async open(serialize?: Serializer, lastUpdated?: string): Promise<void> {
    if (this.opened) throw new Error('database reopened')

    print('indexed: opening cache')
    this.db = await openDB<Schema>('BetterBibTeXCache', this.schema, {
      upgrade: (db, oldVersion, newVersion) => {
        if (oldVersion !== newVersion) {
          for (const store of db.objectStoreNames) {
            db.deleteObjectStore(store)
          }
        }

        db.createObjectStore('ExportFormat', { keyPath: 'itemID' })
        db.createObjectStore('metadata')
      },
    })

    print('indexed: attaching ExportFormat')
    this.ExportFormat = new ExportFormat(this.db, serialize)
    print('indexed: attached ExportFormat')

    if (lastUpdated) {
      const lastTouched = await this.db.get('metadata', 'lastUpdated') || ''
      if (lastUpdated > lastTouched) await this.db.clear('ExportFormat')
    }
    /*
      Exported: { keyPath: ['context', 'itemID'], indices: { // keyPath order matters for key retrieval!
        itemID: { unique: false },
        context: { unique: false }
      } },
      ExportContext:{ keyPath: 'id', autoIncrement: true, indices: {
        properties: { unique: false, multiEntry: true },
      } }
    */
    print('indexed: opened cache')
    this.opened = true
  }

  public close(): void {
    this.db.close()
  }

  public async export(): Promise<Record<string, any>> {
    const tables: Record<string, any> = {}
    for (const store of this.db.objectStoreNames) {
      if (store === 'metadata') {
        tables[store] = {}
        for (const key of await this.db.getAllKeys(store)) {
          tables[store][key] = await this.db.get(store, key)
        }
      }
      else {
        const tx = this.db.transaction(store, 'readonly')
        tables[store] = await tx.store.getAll()
        await tx.done
      }
    }

    return tables
  }
}
