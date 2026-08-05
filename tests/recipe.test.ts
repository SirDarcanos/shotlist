import { describe, expect, it } from 'vitest'
import {
  expandSteps,
  interpolate,
  nearestVerb,
  parseRecipe,
  withNumbering,
} from '../src/recipe.js'
import type { Macro, StepInput } from '../src/recipe.js'

/** The macro set the expansion tests share. */
function macros(extra: Record<string, Macro> = {}): Map<string, Macro> {
  return new Map(
    Object.entries({
      openModal: {
        defaults: { row: 'Acme Corp' },
        steps: [{ click: { css: 'button', text: 'Edit', within: '$row' } }] as StepInput[],
      },
      ...extra,
    }),
  )
}

describe('parseRecipe', () => {
  it('defaults a recipe down to its name and a viewport clip', () => {
    const recipe = parseRecipe({}, { name: 'empty' })
    expect(recipe.name).toBe('empty')
    expect(recipe.source).toBe('app')
    expect(recipe.clip).toBe('viewport')
    expect(recipe.setup).toEqual([])
  })

  it('suggests the verb an author meant', () => {
    expect(nearestVerb('clik')).toBe('click')
    expect(nearestVerb('fil')).toBe('fill')
    expect(nearestVerb('somethingelseentirely')).toBeNull()
    expect(() => parseRecipe({ setup: [{ clik: { css: 'button' } }] }, { name: 'x' })).toThrow(
      /unknown step "clik" — did you mean "click"\?/,
    )
  })

  it('points at the step that is wrong, not just the recipe', () => {
    expect(() =>
      parseRecipe({ setup: [{ click: { css: 'a' } }, { presss: 'Enter' }] }, { name: 'x' }),
    ).toThrow(/setup\[1\]/)
  })

  it('checks the verbs inside a nested block too', () => {
    expect(() =>
      parseRecipe({ setup: [{ repeat: 2, steps: [{ clic: { css: 'a' } }] }] }, { name: 'x' }),
    ).toThrow(/setup\[0\]\.steps\[0\].*unknown step "clic"/s)
  })

  it('refuses a callout pointing at a mark the recipe never defines', () => {
    expect(() =>
      parseRecipe(
        { marks: { total: { css: '.total' } }, callouts: [{ mark: 'totl', text: 'The total' }] },
        { name: 'x' },
      ),
    ).toThrow(/mark "totl".*it defines total/s)
  })

  it('refuses a file recipe with no file to annotate', () => {
    expect(() => parseRecipe({ source: 'file' }, { name: 'x' })).toThrow(/needs a `file:`/)
  })

  it('resolves aliases before validating, so an author sees their own query', () => {
    const recipe = parseRecipe(
      { marks: { row: { listRow: 'Acme Corp' } } },
      { name: 'x', finders: { listRow: { css: 'div', contains: '$1' } } },
    )
    expect(recipe.marks['row']).toEqual({ css: 'div', contains: 'Acme Corp' })
  })
})

describe('withNumbering', () => {
  it('turns the shorthand into one corner disc per mark, in order', () => {
    const recipe = withNumbering(
      parseRecipe(
        { marks: { a: { css: '.a' }, b: { css: '.b' } }, numbered: ['a', 'b'] },
        { name: 'x' },
      ),
    )
    expect(recipe.callouts).toEqual([
      expect.objectContaining({ mark: 'a', n: 1, place: 'corner' }),
      expect.objectContaining({ mark: 'b', n: 2, place: 'corner' }),
    ])
  })

  it('keeps callouts written by hand alongside the numbered ones', () => {
    const recipe = withNumbering(
      parseRecipe(
        {
          marks: { a: { css: '.a' }, b: { css: '.b' } },
          callouts: [{ mark: 'a', text: 'By hand' }],
          numbered: ['b'],
        },
        { name: 'x' },
      ),
    )
    expect(recipe.callouts).toHaveLength(2)
    expect(recipe.callouts[0]?.text).toBe('By hand')
  })
})

describe('expandSteps', () => {
  it('inlines a macro and records its defaults as the frame', () => {
    const expanded = expandSteps([{ use: 'openModal' }], macros())
    expect(expanded).toHaveLength(1)
    expect(expanded[0]?.vars).toEqual({ row: 'Acme Corp' })
  })

  it('lets `with` override a default', () => {
    const expanded = expandSteps([{ use: 'openModal', with: { row: 'Northwind Ltd' } }], macros())
    expect(expanded[0]?.vars).toEqual({ row: 'Northwind Ltd' })
  })

  it('lists the macros a project defines when one is misspelled', () => {
    expect(() => expandSteps([{ use: 'openModel' }], macros())).toThrow(
      /unknown macro "openModel".*openModal/s,
    )
  })

  it('refuses a macro that uses itself', () => {
    const looping = macros({
      loop: { defaults: {}, steps: [{ use: 'loop' }] as StepInput[] },
    })
    expect(() => expandSteps([{ use: 'loop' }], looping)).toThrow(/uses itself \(loop → loop\)/)
  })

  it('expands the steps nested in a loop, keeping the loop itself', () => {
    const expanded = expandSteps(
      [{ repeat: 2, steps: [{ use: 'openModal' }] }],
      macros(),
    )
    expect(expanded).toHaveLength(1)
    expect(expanded[0]?.nested).toHaveLength(1)
    expect(expanded[0]?.nested?.[0]?.vars).toEqual({ row: 'Acme Corp' })
  })
})

describe('interpolate', () => {
  it('returns the value itself when the whole string is one reference', () => {
    expect(interpolate('$rows', { rows: [1, 2] })).toEqual([1, 2])
  })

  it('substitutes a reference inside a longer string', () => {
    expect(interpolate('order $id', { id: 42 })).toBe('order 42')
  })

  it('reads a dotted path', () => {
    expect(interpolate('${customer.name}', { customer: { name: 'Acme Corp' } })).toBe('Acme Corp')
  })

  it('walks into a query object', () => {
    expect(interpolate({ css: 'div', contains: '$who' }, { who: 'Acme Corp' })).toEqual({
      css: 'div',
      contains: 'Acme Corp',
    })
  })

  it('fails loudly when a whole-value reference has nothing behind it', () => {
    expect(() => interpolate('$missing', {})).toThrow(/no value for \$missing/)
  })

  it('leaves an unresolved reference inside a longer string alone', () => {
    // A screenshot of literal text like "costs $5" must survive the interpolator.
    expect(interpolate('costs $5', {})).toBe('costs $5')
  })
})
