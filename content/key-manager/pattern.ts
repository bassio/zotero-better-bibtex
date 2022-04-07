/* eslint-disable @typescript-eslint/no-unsafe-return */

import * as recast from 'recast'
import api from '../../gen/api/key-formatter.json'
const methodnames: Record<string, string> = Object.keys(api).reduce((acc, name) => { acc[name.toLowerCase()]=name; return acc }, {} as Record<string, string>)
console.log(methodnames)
function findMethod(fname: string): string {
  const uscore = fname.replace(/[a-z][A-Z]/g, chr => `${chr[0]}_${chr[1]}`).toLowerCase()
  const duscore = fname.replace(/[a-z][A-Z]/g, chr => `${chr[0]}__${chr[1]}`).toLowerCase()
  console.log('find', uscore, duscore, methodnames[uscore] || methodnames[duscore])
  return methodnames[uscore] || methodnames[duscore]
}

type AST = any
type Creator = { fname: string, onlyEditors?: boolean, scrub?: boolean }

const Ajv = require('ajv')
const ajv = new Ajv()
const betterAjvErrors = require('better-ajv-errors').default

for (const method of Object.values(api)) {
  (method  as any).validate = ajv.compile((method  as any).schema)
}

for (const fname in api) {
  if (fname[0] !== '_' && fname[0] !== '$') throw new Error(`Unexpected fname ${fname}`)
}

export class PatternParser {
  public code: string
  private finder: AST
  private ftype: string

  constructor(source: string) {
    this.finder = recast.parse('[].find(pattern => { try { return pattern() } catch (err) { if (err.next) return ""; throw err } })')
    this.addpattern(recast.parse(source).program.body[0].expression)
    this.code = recast.prettyPrint(this.finder, {tabWidth: 2}).code
  }

  private error(expr): void {
    throw new Error(`Unexpected ${expr.type} at ${expr.loc.start.column}`)
  }

  protected Literal(expr: AST, _context: any): AST {
    return expr
  }

  private creator(name :string): Creator {
    const m = name.match(/^[$]?(([Aa]uthors|[Aa]uth)|([Ee]dtr|[Ee]ditors))([.a-zA-Z]*)$/)
    if (!m) return null

    const [ , prefix, , editor, rest ] = m
    const function_name = `${prefix}${rest}`
    const onlyEditors = !!editor
    const scrub = !!prefix.match(/^[ae]/)
    console.log('creator.name', name, function_name)

    let fname = ''
    for (let [author, editor] of [['authors', 'editors'], ['author', 'editor'], ['authAuth', 'edtrEdtr'], [ 'auth', 'edtr' ]]) {
      fname = function_name.startsWith(editor) ? fname = function_name.replace(editor, author) : function_name
      console.log('creator.fname', function_name, findMethod(`$${fname}`))
      if (fname = findMethod(`$${fname}`)) break

      author = author[0].toUpperCase() + author.slice(1)
      editor = editor[0].toUpperCase() + editor.slice(1)
      fname = function_name.startsWith(editor) ? fname = function_name.replace(editor, author) : function_name
      console.log('creator.fname', function_name, findMethod(`$${fname}`))
      if (fname = findMethod(`$${fname}`)) break
    }

    const method = api[fname]
    if (!method) return null

    const auth = { fname, scrub, onlyEditors, withInitials: false }
    for (const field of Object.keys(auth)) {
      if (!method.parameters.includes(field)) delete auth[field]
    }
    console.log('creator.auth', name, fname, auth)
    return auth
  }

  private resolveArguments(fname: string, args: AST[]): AST[] {
    const method = api[findMethod(fname)] // transitional before rename in formatter.ts
    const kind = {$: 'function', _: 'filter'}[fname[0]]
    fname = fname.slice(1)
    const me = `${kind} ${JSON.stringify(fname)}`
    if (!method) throw new Error(`No such ${me}`)

    const disarray = args.find((arg, i) => arg.named_argument && args[i+1] && !args[i+1].named_argument)
    if (disarray) throw new Error(`${me}: named argument ${disarray.named_argument} is followed by positional arguments`)

    const parameters = {}
    if (method.rest) {
      if (method.parameters.length !== 1) throw new Error(`${me}: ...rest method may have only one parameter, got ${method.parameters.join(', ')}`)
      if (args.find(arg => arg.named_argument)) throw new Error(`${me}: named argument not supported in rest function`)
      args = args.map(({ _loc, ...arg }) => arg) // eslint-disable-line @typescript-eslint/no-unsafe-return
      parameters[method.rest] = { type: 'ArrayExpression', elements: args }
    }
    else {
      if (method.parameters.length < args.length) throw new Error(`${me}: expected ${method.parameters.length} arguments, got ${args.length}`)

      const names = []
      console.log(me, args, parameters)
      args = args.map((arg, i) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { named_argument, _loc, ...argc } = arg
        const name = named_argument || method.parameters[i]
        if (names.includes(name)) throw new Error(`${me}: duplicate parameter ${name}`)
        names.push(name)
        parameters[name] = argc
        return argc
      })
      args = method.parameters.map((param: string) => parameters[param] as AST || { type: 'Identifier', name: 'undefined' } as AST)
    }

    if (!method.validate(parameters)) {
      const err = betterAjvErrors(method.schema, parameters, method.validate.errors, { format: 'js' })[0]
      let msg = err.error
      if (err.path && err.path[0] === '/') msg = msg.replace(err.path, JSON.stringify(err.path.substr(1)))
      if (err.suggestion) msg += `, ${err.suggestion}`
      throw new Error(`${me}: ${msg}`)
    }

    return args
  }

  protected Identifier(expr: AST, context: any): AST {
    let author: Creator
    if (context.arguments) {
      return { type: 'Literal', value: expr.name }
    }
    else if (expr.type !== 'Identifier') {
      return expr
    }
    else if (author = this.creator(expr.name)) {
      console.log('ident', author)
      const method = api[`$${author.fname}`]
      if (!method) throw new Error(`No such function ${author.fname}`)

      const args = [ { type: 'Literal', value: author.scrub, named_argument: 'scrub' } ]
      for (const field of Object.keys(author)) {
        if (field !== 'name') {
          args.push({ type: 'Literal', value: author[field], named_argument: field })
        }
      }
      return {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: author.fname },
        arguments: args,
      } as AST
    }
    else if (expr.name.match(/^[A-Z]/)) {
      // TODO: field lookup here
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return {type: 'CallExpression', callee: { type: 'Identifier', name: 'get_field' }, arguments: [ { type: 'Literal', value: expr.name.replace(/^./, c => c.toLowerCase()) } ]} as AST
    }
    else {
      return { type: 'CallExpression', callee: expr, arguments: [] } as AST
    }
  }

  protected CallExpression(expr: AST, context: any): AST {
    const callee = (expr.callee.type === 'MemberExpression') ? { ...expr.callee, object: this.convert(expr.callee.object, context) } : expr.callee
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return {
      ...expr,
      callee,
      arguments: expr.arguments.map((arg: AST) => this.convert(arg, {...context, arguments: true })),
    }
  }

  protected MemberExpression(expr: AST, context: any): AST {
    return {
      ...expr,
      object: this.convert(expr.object, context),
      property: this.convert(expr.property, context),
    }
  }

  protected AssignmentExpression(expr: AST, context: any): AST {
    if (!context.arguments) this.error(expr)
    return {...this.convert(expr.right, context), named_argument: expr.left.name}
  }

  protected BinaryExpression(expr: AST, context: any): AST {
    if (expr.operator !== '+') this.error(expr)
    return {
      ...expr,
      left: this.convert(expr.left, context),
      right: this.convert(expr.right, context),
    }
  }

  private addThis(expr: AST, context: any): AST {
    let this_expr: AST
    switch (expr.type) {
      case 'BinaryExpression':
        if (expr.operator !== '+') throw expr
        return {
          ...expr,
          left: this.addThis(expr.left, context),
          right: this.addThis(expr.right, context),
        }
      case 'Literal':
        return expr
      default:
        this_expr = { type: 'MemberExpression', object: { type: 'ThisExpression' }, property: expr }
        if (context.coerce) {
          context.coerce = false
          return {
            type: 'BinaryExpression',
            operator: '+',
            left: { type: 'Literal', value: '' },
            right: this_expr,
          }
        }
        else {
          return this_expr
        }
    }
  }

  private convert(expr: AST, context: any): AST {
    if (!this[expr.type]) this.error(expr)
    return this[expr.type](expr, context) as AST
  }

  private resolve(expr: AST) {
    let fname: string
    let author: Creator

    switch (expr.type) {
      case 'CallExpression':
        if (expr.callee.type === 'Identifier' && this.ftype === '$') {
          fname = this.ftype
          this.ftype = '_'
        }
        else {
          fname = '_'
        }

        if (expr.callee.type === 'Identifier') {
          console.log('callex ident', expr.callee.name)
          fname = expr.callee.name = `${fname}${expr.callee.name}`
        }
        else if (expr.callee.type === 'MemberExpression' && expr.callee.property.type === 'Identifier') {
          console.log('callex member', expr.callee.property.name)
          fname = expr.callee.property.name = `${fname}${expr.callee.property.name}`
        }
        else {
          throw expr
        }

        console.log('callexpr', fname)
        if (author = this.creator(fname)) {
          console.log('callexpr auth', author)
          fname = `$${author.fname}`
          expr.arguments.push({ type: 'Literal', value: author.scrub, named_argument: 'scrub' })
          if (typeof author.onlyEditors !== 'undefined') expr.arguments.push({ type: 'Literal', value: author.onlyEditors, named_argument: 'onlyEditors' })
        }

        expr.arguments = this.resolveArguments(fname, expr.arguments)
        this.resolve(expr.callee)
        break

      case 'MemberExpression':
        this.resolve(expr.object)
        this.resolve(expr.property)
        break

      case 'BinaryExpression':
        this.ftype = '$'
        this.resolve(expr.left)
        this.ftype = '$'
        this.resolve(expr.right)
        break

      case 'Literal':
      case 'Identifier':
        break

      default:
        throw new Error(`Cannot resolve ${expr.type}`)
    }
  }

  private insert(expr: AST) {
    expr = this.convert(expr, {})
    this.ftype = '$'
    this.resolve(expr)
    expr = this.addThis(expr, { coerce: true })

    this.finder.program.body[0].expression.callee.object.elements.push({ type: 'ArrowFunctionExpression', params: [], body: expr, expression: true })
  }

  private addpattern(expr: AST) {
    if (expr.type === 'BinaryExpression' && expr.operator === '|') {
      this.addpattern(expr.left)
      this.insert(expr.right)
    }
    else {
      this.insert(expr)
    }
  }
}
