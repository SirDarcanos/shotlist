import { describe, expect, it } from 'vitest'
import {
  MAX_QUERY_DEPTH,
  checkPath,
  checkUrl,
  interpolate,
  parseQuery,
  parseRecipe,
  secretIn,
  trustFrom,
} from '../src/index.js'

const NUL = String.fromCharCode(0)
const SITE = 'https://rollful.dev/'
const guard = (deny: string[] = [], untrusted = true) =>
  trustFrom({ root: '/project', siteUrl: SITE, deny }, untrusted)

// Everything here is a thing somebody would try on purpose. Each one was run against the
// real code before it was written down, and four of them worked.
describe('a URL written to look like the site', () => {
  it('reads the host, not the part of the URL that resembles one', () => {
    for (const url of [
      'https://rollful.dev@evil.test/', // the host is evil.test
      'http://rollful.dev:8080@evil.test/',
      'https://evil.test#rollful.dev',
      'https://evil.test/?x=rollful.dev',
      'https://rollful.dev.evil.test/',
      'https://evilrollful.dev/',
      'https://xn--rllful-5wa.dev/', // а Cyrillic homograph, punycoded
    ]) {
      expect(() => checkUrl(guard(), url, '`url`'), url).toThrow(/not this site/)
    }
  })

  it('is not fooled by case', () => {
    expect(() => checkUrl(guard(), 'https://ROLLFUL.DEV/x', '`url`')).not.toThrow()
  })
})

// A name hidden behind a null byte is a name the check never sees and the filesystem
// still opens: `.env\0.png` is `.env` to everything downstream.
describe('a path hiding behind a control character', () => {
  it('matches the name a null byte was meant to hide', () => {
    expect(secretIn(`/project/.env${NUL}.png`)).toBe('.env')
    expect(secretIn(`/project/fake-secret${NUL}x/a`, ['fake-secret'])).toBe('fake-secret')
  })

  it('refuses the path outright, whatever it was hiding', () => {
    expect(() => checkPath(guard(), `/project/a${NUL}b.png`, 'install')).toThrow(
      /holds a control character/,
    )
    expect(() => checkPath(guard(), '/project/a\nb.png', 'install')).toThrow(
      /holds a control character/,
    )
  })

  it('refuses it in a URL path too', () => {
    expect(() => checkUrl(guard(['fake-secret']), 'https://rollful.dev/a%00b', '`url`')).toThrow(
      /holds a control character/,
    )
  })

  it('sees through percent-encoding, which the server will decode', () => {
    expect(() =>
      checkUrl(guard(['fake-secret']), 'https://rollful.dev/%66ake-secret/x', '`url`'),
    ).toThrow(/forbidden path/)
  })
})

// A repository can contain a link, and a link points wherever it likes. Comparing the
// written path would confine an untrusted run to a doormat.
describe('a symlink out of the project', () => {
  it('follows it before deciding, so the destination is what counts', async () => {
    const { mkdtempSync, mkdirSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const base = mkdtempSync(join(tmpdir(), 'shotlist-link-'))
    mkdirSync(join(base, 'project'))
    mkdirSync(join(base, 'elsewhere'))
    symlinkSync(join(base, 'elsewhere'), join(base, 'project', 'escape'))

    const trust = trustFrom({ root: join(base, 'project'), siteUrl: SITE }, true)
    expect(() => checkPath(trust, join(base, 'project', 'escape', 'x.png'), 'install')).toThrow(
      /outside the project/,
    )
    expect(() => checkPath(trust, join(base, 'project', 'ok', 'x.png'), 'install')).not.toThrow()
  })
})

// A data file holds data. `$__proto__` answered with Object.prototype, and a step is free
// to put whatever a reference resolves to into a query.
describe('a reference reaching past the data', () => {
  it('reads nothing that belongs to the language', () => {
    for (const reference of [
      '$__proto__',
      '${__proto__}',
      '${constructor}',
      '${constructor.name}',
      '${a.__proto__.x}',
      '${a.constructor.name}',
      '${a.prototype}',
    ]) {
      expect(() => interpolate(reference, { a: {} }), reference).toThrow(/no value for/)
    }
  })

  it('still reads what the data actually holds', () => {
    expect(interpolate('${order.total}', { order: { total: 42 } })).toBe(42)
  })

  it('reads an own key that happens to share a name with nothing', () => {
    expect(interpolate('$toString', { toString: 'yes' })).toBe('yes')
    // Inherited, not held: a data file has no `toString` of its own.
    expect(() => interpolate('$toString', {})).toThrow(/no value for/)
  })
})

// `span` holds queries, so a query nests without limit — and everything that walks one
// recurses, the schema included.
describe('a query nested past what anyone means', () => {
  it('is refused rather than overflowing the stack', () => {
    let deep: unknown = { css: 'div' }
    for (let i = 0; i < 5000; i++) deep = { span: [deep] }
    expect(() => parseQuery(deep)).toThrow(new RegExp(`more than ${MAX_QUERY_DEPTH} deep`))
  })

  it('leaves a query anybody would write alone', () => {
    expect(() =>
      parseQuery({ span: [{ span: [{ css: '.a' }, { css: '.b' }] }, { css: '.c' }] }),
    ).not.toThrow()
  })
})

describe('a recipe name that is not a name', () => {
  it('refuses a path, a traversal, a control character and an empty one', () => {
    for (const name of ['../escaped', 'a/b', '..', '.', `a${NUL}b`, 'a\nb', 'a\rb']) {
      expect(() => parseRecipe({ name }, { name: 'fallback' }), JSON.stringify(name)).toThrow()
    }
  })

  it('leaves a name with punctuation and letters from anywhere alone', () => {
    for (const name of ['order-row', 'order_row.2', 'ordine—riga', '注文', 'café']) {
      expect(parseRecipe({ name }, { name: 'fallback' }).name, name).toBe(name)
    }
  })
})
