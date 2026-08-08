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

// The engine that answers `role`/`label`/`placeholder`/`testid` runs before this one.
// Absent seeds mean it never ran — the query is nested somewhere it cannot be. Empty
// seeds mean it ran and found nothing, which is an ordinary no-match.
describe('a source Playwright resolves', () => {
  it('says nothing matched when the engine ran and came back empty', () => {
    expect(() =>
      evaluateQuery({ spec: { placeholder: 'Search packages' }, viewport: VIEWPORT, seeds: [] }),
    ).toThrow(/^no element matched /)
  })

  it('says it cannot be nested when the engine never ran at all', () => {
    expect(() => find({ placeholder: 'Search packages' })).toThrow(/cannot be used inside/)
  })
})

// Negative counts from the end, the way `Array.at` does. Checked against a list of four,
// so that no assertion here holds only because the list is as long as the index is deep:
// in a list of two, `-2` and `0` are the same element, and that proves nothing.
describe('a position counted from the end', () => {
  // The bar, in order: New order, Import, Export, Settings.
  const BAR = [
    { x: 16, y: 14, width: 90, height: 32 },
    { x: 118, y: 14, width: 80, height: 32 },
    { x: 210, y: 14, width: 120, height: 32 },
    { x: 342, y: 14, width: 64, height: 32 },
  ]
  const button = (over: object) => find({ css: '.bar button', ...over })

  it('walks back from the last one, one at a time', () => {
    expect(button({ nth: -1 })).toEqual(BAR[3])
    expect(button({ nth: -2 })).toEqual(BAR[2])
    expect(button({ nth: -3 })).toEqual(BAR[1])
    expect(button({ nth: -4 })).toEqual(BAR[0])
  })

  it('agrees with `pick: last`, which is true whatever the length', () => {
    expect(button({ nth: -1 })).toEqual(button({ pick: 'last' }))
  })

  it('says nothing is there when it counts back past the start', () => {
    expect(() => button({ nth: -5 })).toThrow(/no element at the requested position/)
  })

  it('reads child: -1 as the last child and -2 as the one before it', () => {
    // The row holds three spans and then the Edit button.
    const row = { css: '.row', contains: 'Acme Corp', pick: 'smallest' as const }
    expect(find({ ...row, child: -1 })).toEqual({ x: 300, y: 80, width: 76, height: 28 })
    expect(find({ ...row, child: -2 })).toEqual({ x: 172, y: 84, width: 52, height: 20 })
    expect(find({ ...row, child: -3 })).toEqual({ x: 92, y: 84, width: 70, height: 20 })
  })
})

// Twenty, so that no index coincides with any other and an off-by-one has nowhere to
// hide. Each item's x is its position, so a rect names which one came back.
describe('counting from the end of a long list', () => {
  const LONG = 20

  beforeEach(() => {
    const items = Array.from(
      { length: LONG },
      (_, i) => `<li class="ledger" data-rect="${i},0,1,1"></li>`,
    ).join('')
    document.body.insertAdjacentHTML('beforeend', `<ul>${items}</ul>`)
  })

  /** Which item came back, read off the x that encodes its position. */
  const at = (nth: number) => find({ css: '.ledger', nth }).x

  it('reads -1 as the last and -2 as the one before it, not as the first', () => {
    expect(at(-1)).toBe(19)
    expect(at(-2)).toBe(18)
    // The whole point: in a list this long, -2 and 0 are nineteen apart.
    expect(at(0)).toBe(0)
    expect(at(-2)).not.toBe(at(0))
  })

  it('walks back the whole way, one at a time', () => {
    for (let back = 1; back <= LONG; back++) expect(at(-back), `nth: -${back}`).toBe(LONG - back)
  })

  it('still counts forward from the front', () => {
    for (let forward = 0; forward < LONG; forward++) expect(at(forward)).toBe(forward)
  })

  it('has nothing one step past either end', () => {
    expect(() => at(-(LONG + 1))).toThrow(/no element at the requested position/)
    expect(() => at(LONG)).toThrow(/no element at the requested position/)
  })
})

describe('traversal', () => {
  it('climbs to the nearest matching ancestor', () => {
    // The select sits in a label, which is the first box around it under 95vw.
    expect(find({ css: 'select', ancestor: { narrowerThan: '95vw' } })).toEqual({
      x: 260,
      y: 260,
      width: 480,
      height: 32,
    })
  })

  it('climbs past it to the outermost one, which is the modal card', () => {
    // The whole reason `outermost` exists: `nearest` stops at the label, and the shot
    // wants the card that holds it — but not the full-screen overlay outside that.
    expect(find({ css: 'select', ancestor: { narrowerThan: '95vw', pick: 'outermost' } })).toEqual({
      x: 240,
      y: 200,
      width: 520,
      height: 300,
    })
  })

  // An element is not its own ancestor. Starting the climb at it returned the element
  // whenever the filters happened to fit, and a heading is as wide as the column it is
  // in — so climbing out of one by width found the heading and boxed that instead.
  it('never answers with the element it started from', () => {
    expect(find({ heading: 'Edit order', ancestor: { narrowerThan: '95vw' } })).toEqual({
      x: 240,
      y: 200,
      width: 520,
      height: 300,
    })
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

  it('refuses a Playwright-resolved source nested where it cannot be seeded', () => {
    // Without this it would search every element on the page and box whichever came
    // first, which looks like a screenshot rather than like a failure.
    expect(() => find({ span: [{ role: 'button', name: 'Run' }, { css: '.bar' }] })).toThrow(
      /`role` cannot be used inside `span` or `within`/,
    )
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
