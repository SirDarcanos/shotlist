import { describe, expect, it } from 'vitest'
import {
  MAX_MATCHING_CHARACTERS,
  MAX_QUERY_DEPTH,
  MAX_STEP_DEPTH,
  interpolate,
  parseQuery,
  parseRecipe,
} from '../src/index.js'
import { compileNetworkPolicy } from '../src/network-policy.js'
import { checkPath, secretIn, trustFrom } from '../src/trust.js'

const NUL = String.fromCharCode(0)
const SITE = 'https://example.com/'
const guard = (deny: string[] = []) =>
  compileNetworkPolicy({
    operator: ['example.com'],
    project: [],
    untrusted: true,
    deny,
  }).forOperation('`url`')
const pathGuard = () => trustFrom({ root: '/project', siteUrl: SITE }, true)

// Everything here is a thing somebody would try on purpose. Each one was run against the
// real code before it was written down, and four of them worked.
describe('a URL written to look like the site', () => {
  it('reads the host, not the part of the URL that resembles one', () => {
    for (const url of [
      'https://example.com@evil.test/', // the host is evil.test
      'http://example.com:8080@evil.test/',
      'https://evil.test#example.com',
      'https://evil.test/?x=example.com',
      'https://example.com.evil.test/',
      'https://evilexample.com/',
      'https://xn--rllful-5wa.dev/', // а Cyrillic homograph, punycoded
    ]) {
      expect(() => guard().check(url), url).toThrow()
    }
  })

  it('is not fooled by case', () => {
    expect(() => guard().check('https://EXAMPLE.COM/x')).not.toThrow()
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
    expect(() => checkPath(pathGuard(), `/project/a${NUL}b.png`, 'install')).toThrow(
      /holds a control character/,
    )
    expect(() => checkPath(pathGuard(), '/project/a\nb.png', 'install')).toThrow(
      /holds a control character/,
    )
  })

  it('refuses it in a URL path too', () => {
    expect(() => guard(['fake-secret']).check('https://example.com/a%00b')).toThrow()
  })

  it('sees through percent-encoding, which the server will decode', () => {
    expect(() => guard(['fake-secret']).check('https://example.com/%66ake-secret/x')).toThrow(
      /forbidden path/,
    )
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

describe('a text pattern that can consume unbounded work', () => {
  it('is refused before a browser sees it', () => {
    for (const matching of ['(a+)+$', '(a|aa)+$', '(.*a){10}', String.raw`^(a+)\1+$`, '(?<=a)b']) {
      expect(() => parseQuery({ matching }), matching).toThrow(/cannot run safely/)
    }
  })

  it('refuses malformed and oversized patterns while retaining ordinary matching', () => {
    expect(() => parseQuery({ matching: '[' })).toThrow(/valid text pattern/)
    expect(() => parseQuery({ matching: 'a'.repeat(MAX_MATCHING_CHARACTERS + 1) })).toThrow(
      new RegExp(`more than ${MAX_MATCHING_CHARACTERS} characters`),
    )
    expect(parseQuery({ matching: String.raw`^Order \d+$` })).toMatchObject({
      matching: String.raw`^Order \d+$`,
    })
  })
})

describe('Steps nested past what anyone means', () => {
  it('are refused before recursive validation can overflow the stack', () => {
    let deep: unknown[] = [{ click: { css: 'button' } }]
    for (let i = 0; i < 5000; i++) deep = [{ optional: deep }]

    expect(() => parseRecipe({ setup: deep }, { name: 'deep' })).toThrow(
      new RegExp(`Steps nested more than ${MAX_STEP_DEPTH} deep`),
    )
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

// A query says where a box is. Several ways of writing one described a box that could
// not exist, and were carried until something further down complained about the result.
describe('a number that describes no box', () => {
  const refused = (query: unknown) => expect(() => parseQuery(query))

  it('refuses padding that is not padding', () => {
    refused({ css: 'div', pad: -8 }).toThrow(/room added around a box/)
    refused({ css: 'div', grow: { left: -4 } }).toThrow(/room added around a box/)
    refused({ span: [{ css: 'a' }, { css: 'b' }], pad: -1 }).toThrow(/room added around a box/)
  })

  it('refuses a literal box with no width or height', () => {
    refused({ rect: [0, 0, -5, 10] }).toThrow()
    refused({ rect: [0, 0, 10, -5] }).toThrow()
    // Off the top-left is a place; a negative size is not a size.
    expect(() => parseQuery({ rect: [-20, -20, 10, 10] })).not.toThrow()
  })
})

// `grow` holds sides, and its keys are not query keys — so a single-sided one read as a
// call to a finder of that name, and the documented form never worked with one side.
describe('a grow with one side', () => {
  it('is a grow, not a call to a finder called left', () => {
    expect(parseQuery({ css: 'div', grow: { left: 4 } })).toEqual({
      css: 'div',
      grow: { left: 4 },
    })
    expect(parseQuery({ css: 'div', grow: { top: 20 } })).toEqual({
      css: 'div',
      grow: { top: 20 },
    })
  })

  it('still expands a finder written alongside one', () => {
    expect(
      parseQuery({ listRow: 'Acme', grow: { top: 8 } }, { listRow: { css: 'li', contains: '$1' } }),
    ).toEqual({ css: 'li', contains: 'Acme', grow: { top: 8 } })
  })
})
