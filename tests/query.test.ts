// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { evaluateQuery, parseQuery, resolveAliases, substitute } from '../src/query.js'
import type { QueryInput, Rect } from '../src/query.js'
import { VIEWPORT, loadFixture } from './fixture.js'

/** Resolve a query against the fixture page. */
function find(query: QueryInput, rects?: Record<string, Rect>): Rect {
  return evaluateQuery({ spec: query, viewport: VIEWPORT, ...(rects ? { rects } : {}) })
}

beforeEach(() => {
  loadFixture()
})

describe('sources and filters', () => {
  it('picks the smallest element holding both a name and an amount', () => {
    // The shape a row has in most list UIs: several ancestors also contain the name,
    // and the row is the tightest box that carries the amount too.
    expect(
      find({
        css: 'li, div',
        contains: 'Acme Corp',
        matching: '\\$\\d',
        maxChildren: 12,
        pick: 'smallest',
      }),
    ).toEqual({ x: 12, y: 72, width: 376, height: 44 })
  })

  it('scopes a search to an already-resolved rect', () => {
    const row = find({ css: 'div', contains: 'Acme Corp', matching: '\\$\\d', pick: 'smallest' })
    expect(find({ text: '$42.00', within: 'row' }, { row })).toEqual({
      x: 172,
      y: 84,
      width: 52,
      height: 20,
    })
  })

  it('refuses a within that names no known rect', () => {
    expect(() => find({ text: '$42.00', within: 'clip' })).toThrow(/not a resolved rect/)
  })

  it('filters by measured size', () => {
    expect(find({ css: 'div', contains: 'Edit order', minWidth: 400, maxWidth: '95vw' })).toEqual({
      x: 240,
      y: 200,
      width: 520,
      height: 300,
    })
  })
})

describe('traversal', () => {
  it('climbs to the nearest matching ancestor', () => {
    expect(find({ heading: 'Edit order', ancestor: { narrowerThan: '95vw' } })).toEqual({
      x: 260,
      y: 220,
      width: 300,
      height: 28,
    })
  })

  it('climbs past it to the outermost one, which is the modal card', () => {
    // The whole reason `outermost` exists: `nearest` stops at the heading itself, and
    // the shot wants the card the heading sits in — but not the full-screen overlay.
    expect(
      find({ heading: 'Edit order', ancestor: { narrowerThan: '95vw', pick: 'outermost' } }),
    ).toEqual({ x: 240, y: 200, width: 520, height: 300 })
  })

  it('takes the children of a container, then one of them', () => {
    expect(find({ css: '.grid', children: true, nth: 1 })).toEqual({
      x: 400,
      y: 60,
      width: 300,
      height: 640,
    })
  })
})

describe('composition', () => {
  it('spans several queries into one box', () => {
    expect(
      find({
        span: [
          { css: 'button', text: 'New order' },
          { css: 'button', text: 'Export' },
        ],
      }),
    ).toEqual({ x: 16, y: 14, width: 314, height: 32 })
  })

  it('pads and grows the result', () => {
    expect(find({ css: 'button', text: 'Run', pad: 4, grow: { top: 10 } })).toEqual({
      x: 708,
      y: 138,
      width: 88,
      height: 50,
    })
  })

  it('takes a literal box, for a recipe annotating an image with no page', () => {
    expect(find({ rect: [866, 874, 150, 50], pad: 2 })).toEqual({
      x: 864,
      y: 872,
      width: 154,
      height: 54,
    })
  })

  it('names the query it could not match', () => {
    expect(() => find({ css: 'button', text: 'Nope' })).toThrow(/no element matched.*Nope/s)
  })
})

describe('aliases', () => {
  const finders = {
    listRow: {
      css: 'li, div',
      contains: '$1',
      matching: '\\$\\d',
      maxChildren: 12,
      pick: 'smallest',
    },
    panel: { heading: '$1', ancestor: { narrowerThan: '95vw', pick: 'outermost' } },
  }

  it('substitutes arguments into a template', () => {
    expect(substitute({ contains: '$1', text: 'row $1' }, ['Acme Corp'])).toEqual({
      contains: 'Acme Corp',
      text: 'row Acme Corp',
    })
  })

  it('expands a one-key call into its template', () => {
    expect(resolveAliases({ listRow: 'Northwind Ltd' }, finders)).toMatchObject({
      contains: 'Northwind Ltd',
    })
  })

  it('resolves an alias nested inside a span', () => {
    const resolved = parseQuery({ span: [{ panel: 'Edit order' }, { css: '.bar' }] }, finders)
    expect(find(resolved)).toEqual({ x: 0, y: 0, width: 1000, height: 500 })
  })

  it('lets a call add its own query keys to what the finder found', () => {
    // `{ listRow: "Acme Corp", pad: 16 }` pads the row the finder located, rather than
    // being refused for having two keys and so not looking like a call at all.
    const padded = resolveAliases({ listRow: 'Acme Corp', pad: 16 }, finders)
    expect(padded).toMatchObject({ contains: 'Acme Corp', pad: 16 })
    expect(find(parseQuery(padded))).toEqual({ x: -4, y: 56, width: 408, height: 76 })
  })

  it('lists the finders a project defines when one is misspelled', () => {
    expect(() => resolveAliases({ listRw: 'Acme Corp' }, finders)).toThrow(
      /unknown finder "listRw".*listRow/s,
    )
  })

  it('reports a missing argument rather than substituting nothing', () => {
    expect(() => resolveAliases({ listRow: [] }, finders)).toThrow(/no argument \$1/)
  })
})

describe('validation', () => {
  it('rejects a key that is not part of the language', () => {
    expect(() => parseQuery({ css: 'div', colour: 'red' } as unknown as QueryInput)).toThrow()
  })

  it('accepts every documented dimension unit', () => {
    expect(() => parseQuery({ css: 'div', narrowerThan: '95vw' })).not.toThrow()
    expect(() => parseQuery({ css: 'div', maxHeight: '50vh' })).not.toThrow()
    expect(() => parseQuery({ css: 'div', minWidth: 400 })).not.toThrow()
    expect(() => parseQuery({ css: 'div', minWidth: 'wide' } as unknown as QueryInput)).toThrow()
  })
})
