import { describe, expect, it, vi } from 'vitest'
import { parseMacro, parseRecipe } from '../src/recipe.js'
import { visitAuthoredSteps } from '../src/step.js'
import {
  authoredWork,
  createRecipeWork,
  preflightMacro,
  preflightRecipe,
  resolveWorkLimits,
} from '../src/work-limit.js'
import type { Macro, Recipe, StepInput } from '../src/recipe.js'

/** Assemble a validated Library around the Recipe under measurement. */
function libraryFor(
  recipe: Recipe,
  macros: ReadonlyMap<string, Macro> = new Map(),
  data: Readonly<Record<string, unknown>> = {},
) {
  return { recipes: new Map([[recipe.name!, recipe]]), macros, data }
}

describe('Authored Work limits', () => {
  it('visits declaration-derived recursive fields iteratively with addressed depths', () => {
    const raw = {
      setup: [{ repeat: 2, steps: [{ click: { css: '.again' } }] }, { optional: [{ wait: 1 }] }],
    }
    const visited: string[] = []

    visitAuthoredSteps(raw, ['setup'], ({ path, depth }) => {
      visited.push(`${path}:${depth}`)
    })

    expect(visited).toEqual([
      'setup[0]:1',
      'setup[1]:1',
      'setup[1].optional[0]:2',
      'setup[0].steps[0]:2',
    ])
    expect(authoredWork(raw, ['setup'])).toEqual({ count: 4, depth: 2 })
  })

  it('counts malformed positions and can stop without entering later hostile nesting', () => {
    let hostile: unknown[] = [{ click: { css: '.leaf' } }]
    for (let depth = 0; depth < 5000; depth++) hostile = [{ optional: hostile }]
    const raw = { steps: [null, 'bad', hostile, { optional: hostile }] }
    const visited: string[] = []

    expect(authoredWork({ steps: [null, 'bad', []] }, ['steps'])).toEqual({ count: 3, depth: 1 })
    visitAuthoredSteps(raw, ['steps'], ({ path }) => {
      visited.push(path)
      return false
    })

    expect(visited).toEqual(['steps[0]'])
  })
})

describe('Recipe Work limits', () => {
  it('stops planning nested known loops once predictable work exceeds the limit', () => {
    const nested = (depth: number): StepInput[] =>
      depth === 0
        ? [{ click: { css: '.leaf' } }]
        : [{ each: '$items', as: `item${depth}`, steps: nested(depth - 1) }]
    const recipe = parseRecipe({ setup: nested(4) }, { name: 'nested' })
    const library = libraryFor(recipe, new Map(), {
      items: Array.from({ length: 100 }, (_, index) => index),
    })

    expect(() => preflightRecipe('nested', recipe, library)).toThrow(/would run/)
  })

  it('gives every declaration Predictable Work semantics', () => {
    const query = { css: '.control' }
    const macro = parseMacro({ steps: [{ click: query }] })
    const recipe = parseRecipe(
      {
        setup: [
          { goto: '/orders' },
          { click: query },
          { dblclick: query },
          { hover: query },
          { fill: query, value: 'Ada' },
          { select: query, option: 'one' },
          { check: query },
          { uncheck: query },
          { press: 'Enter' },
          { type: 'Ada' },
          { blur: query },
          { scrollIntoView: query },
          { wait: 1 },
          { dialog: 'dismiss' },
          { readValue: query, as: 'name' },
          { use: 'ordinary' },
          { repeat: 2, steps: [] },
          { each: [], steps: [] },
          { optional: [] },
          { openPage: '/details', as: 'details' },
          { usePage: 'details' },
        ],
      },
      { name: 'declarations' },
    )

    expect(
      preflightRecipe('declarations', recipe, libraryFor(recipe, new Map([['ordinary', macro]])))
        .setup,
    ).toEqual({
      expanded: 21,
      executed: 21,
      milliseconds: 1,
      eachItems: 0,
      macroDepth: 1,
    })
  })

  it('projects ordinary Steps and only numeric waits as predictable work', () => {
    const recipe = parseRecipe(
      {
        setup: [{ click: { css: '.save' } }, { wait: 5 }, { wait: { css: '.ready' } }],
      },
      { name: 'ordinary' },
    )

    expect(preflightRecipe('ordinary', recipe, libraryFor(recipe)).setup).toEqual({
      expanded: 3,
      executed: 3,
      milliseconds: 5,
      eachItems: 0,
      macroDepth: 0,
    })
  })

  it('projects optional and repeat through their declared composition', () => {
    const recipe = parseRecipe(
      {
        setup: [
          { optional: [{ click: { css: '.close' } }, { wait: 2 }] },
          {
            repeat: 2,
            steps: [{ click: { css: '.next' } }, { wait: 3 }],
          },
        ],
      },
      { name: 'blocks' },
    )

    expect(preflightRecipe('blocks', recipe, libraryFor(recipe)).setup).toEqual({
      expanded: 6,
      executed: 8,
      milliseconds: 8,
      eachItems: 0,
      macroDepth: 0,
    })
  })

  it('sums known each scopes while retaining only their largest expansion', () => {
    const recipe = parseRecipe(
      {
        setup: [
          {
            each: '$rows',
            as: 'row',
            steps: [
              {
                each: '$row.cells',
                steps: [{ click: { css: '.cell' } }, { wait: 2 }],
              },
            ],
          },
        ],
      },
      { name: 'rows' },
    )
    const library = libraryFor(recipe, new Map(), {
      rows: [{ cells: ['a', 'b'] }, { cells: ['c'] }],
    })

    expect(preflightRecipe('rows', recipe, library).setup).toEqual({
      expanded: 4,
      executed: 9,
      milliseconds: 6,
      eachItems: 2,
      macroDepth: 0,
    })
  })

  it('refuses a known each list before projecting its first item', () => {
    const recipe = parseRecipe(
      { setup: [{ each: '$rows', steps: [{ use: 'missing' }] }] },
      { name: 'too-many' },
    )

    expect(() =>
      preflightRecipe(
        'too-many',
        recipe,
        libraryFor(recipe, new Map(), { rows: ['first', 'second'] }),
        resolveWorkLimits({ eachItems: 1 }),
      ),
    ).toThrow(/each would process 2 items; the Work limit is 1/)
  })

  it('retains empty each structure but not its body execution or wait', () => {
    const recipe = parseRecipe(
      {
        setup: [
          {
            each: '$rows',
            steps: [{ click: { css: '.row' } }, { wait: 5 }],
          },
        ],
      },
      { name: 'empty' },
    )

    expect(
      preflightRecipe('empty', recipe, libraryFor(recipe, new Map(), { rows: [] })).setup,
    ).toEqual({
      expanded: 3,
      executed: 1,
      milliseconds: 0,
      eachItems: 0,
      macroDepth: 0,
    })
  })

  it('keeps unresolved each at its current structural count', () => {
    const recipe = parseRecipe(
      { setup: [{ each: '$missing', steps: [{ click: { css: '.row' } }] }] },
      { name: 'unknown-list' },
    )

    expect(preflightRecipe('unknown-list', recipe, libraryFor(recipe)).setup).toMatchObject({
      expanded: 1,
      executed: 1,
    })
  })

  it('leaves cyclic known references unresolved without recursive failure', () => {
    const recipe = parseRecipe(
      { setup: [{ each: '$first', steps: [{ click: { css: '.row' } }] }] },
      { name: 'cyclic-data' },
    )

    expect(
      preflightRecipe(
        'cyclic-data',
        recipe,
        libraryFor(recipe, new Map(), { first: '$second', second: '$first' }),
      ).setup,
    ).toMatchObject({ expanded: 1, executed: 1 })
  })

  it('applies Macro defaults and lets with arguments take precedence', () => {
    const macro = parseMacro({
      defaults: { rows: ['default'] },
      steps: [{ each: '$rows', steps: [{ click: { css: '.row' } }] }],
    })
    const macros = new Map([['openRows', macro]])
    const recipe = parseRecipe(
      { setup: [{ use: 'openRows', with: { rows: ['first', 'second'] } }] },
      { name: 'macro-arguments' },
    )

    expect(
      preflightRecipe(
        'macro-arguments',
        recipe,
        libraryFor(recipe, macros, { rows: ['library', 'values', 'lose'] }),
      ).setup,
    ).toEqual({
      expanded: 2,
      executed: 3,
      milliseconds: 0,
      eachItems: 2,
      macroDepth: 1,
    })
  })

  it('resolves Macro argument references against the enclosing scope', () => {
    const macro = parseMacro({
      defaults: { rows: [] },
      steps: [{ each: '$rows', steps: [{ click: { css: '.row' } }] }],
    })
    const macros = new Map([['openRows', macro]])
    const recipe = parseRecipe(
      { setup: [{ use: 'openRows', with: { rows: '$rows' } }] },
      { name: 'macro-reference' },
    )

    expect(
      preflightRecipe(
        'macro-reference',
        recipe,
        libraryFor(recipe, macros, { rows: ['first', 'second'] }),
      ).setup,
    ).toMatchObject({ expanded: 2, executed: 3, eachItems: 2 })
  })

  it('preserves unknown, recursive, and depth-limited Macro failures', () => {
    const unknown = parseRecipe({ setup: [{ use: 'missing' }] }, { name: 'unknown' })
    expect(() => preflightRecipe('unknown', unknown, libraryFor(unknown))).toThrow(
      'unknown macro "missing"',
    )

    const first = parseMacro({ steps: [{ use: 'second' }] })
    const second = parseMacro({ steps: [{ use: 'first' }] })
    const macros = new Map([
      ['first', first],
      ['second', second],
    ])
    expect(() => preflightMacro('first', { recipes: new Map(), macros, data: {} })).toThrow(
      /macro "first" uses itself \(first → second → first\)/,
    )
    expect(() =>
      preflightMacro(
        'first',
        { recipes: new Map(), macros, data: {} },
        resolveWorkLimits({ macroDepth: 1 }),
      ),
    ).toThrow(/Macro expansion is more than 1 deep/)
  })

  it('stops before a later Macro error once predictable work exceeds a limit', () => {
    const recipe = parseRecipe(
      {
        setup: [
          { repeat: 2, steps: [{ click: { css: '.one' } }, { click: { css: '.two' } }] },
          { use: 'missing' },
        ],
      },
      { name: 'early' },
    )

    expect(() =>
      preflightRecipe('early', recipe, libraryFor(recipe), resolveWorkLimits({ executedSteps: 4 })),
    ).toThrow(/would run 5 Steps/)
  })

  it('saturates predictable arithmetic at the largest safe integer', () => {
    let steps: StepInput[] = [{ click: { css: '.leaf' } }]
    for (let depth = 0; depth < 6; depth++) steps = [{ repeat: 1000, steps }]
    const recipe = parseRecipe({ setup: steps }, { name: 'saturated' })
    const maximum = Number.MAX_SAFE_INTEGER

    expect(
      preflightRecipe(
        'saturated',
        recipe,
        libraryFor(recipe),
        resolveWorkLimits({ executedSteps: maximum }),
      ).setup.executed,
    ).toBe(maximum)
  })

  it('gives each retry a fresh Executed Step count', () => {
    const recipe = createRecipeWork(resolveWorkLimits({ executedSteps: 1 }), 'retried')
    const first = recipe.attempt()
    first.step()
    expect(() => first.step()).toThrow(/ran more than 1 Step/)

    expect(() => recipe.attempt().step()).not.toThrow()
    recipe.dispose()
  })

  it('stops work when the Recipe time shared by its attempts expires', async () => {
    vi.useFakeTimers()
    try {
      const recipe = createRecipeWork(
        resolveWorkLimits({ recipeMilliseconds: 10, teardownMilliseconds: 5 }),
        'slow',
      )
      const first = recipe.attempt()
      first.step()
      const second = recipe.attempt()
      let fail!: (error: Error) => void
      const operation = new Promise<never>((_resolve, reject) => {
        fail = reject
      })
      const stopped = vi.fn(() => {
        fail(new Error('execution context was destroyed'))
        return Promise.resolve()
      })
      const running = second.run(() => operation, stopped)
      const rejected = expect(running).rejects.toThrow(/recipe "slow" reached its 10ms Work limit/)

      await vi.advanceTimersByTimeAsync(10)

      await rejected
      expect(stopped).toHaveBeenCalledOnce()
      recipe.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not charge awaited observation to the Recipe deadline', async () => {
    vi.useFakeTimers()
    try {
      const recipe = createRecipeWork(
        resolveWorkLimits({ recipeMilliseconds: 10, teardownMilliseconds: 5 }),
        'observed',
      )
      let release!: () => void
      const observing = recipe.observe(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )

      await vi.advanceTimersByTimeAsync(100)
      release()
      await observing

      const running = recipe.attempt().run(() => new Promise<never>(() => {}))
      let settled = false
      void running.catch(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(9)
      expect(settled).toBe(false)
      const rejected = expect(running).rejects.toThrow(/reached its 10ms Work limit/)
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      recipe.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('limits an early teardown to its own duration', async () => {
    vi.useFakeTimers()
    try {
      const recipe = createRecipeWork(
        resolveWorkLimits({ recipeMilliseconds: 100, teardownMilliseconds: 5 }),
        'early-cleanup',
      )
      const teardown = recipe.teardown()
      const running = teardown.run(() => new Promise<never>(() => {}))
      const rejected = expect(running).rejects.toThrow(/teardown reached its 5ms Work limit/)

      await vi.advanceTimersByTimeAsync(5)

      await rejected
      recipe.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives teardown its reserved Steps and extra time', async () => {
    vi.useFakeTimers()
    try {
      const recipe = createRecipeWork(
        resolveWorkLimits({
          recipeMilliseconds: 10,
          teardownMilliseconds: 5,
          teardownSteps: 1,
        }),
        'cleanup',
      )
      await vi.advanceTimersByTimeAsync(10)
      const teardown = recipe.teardown()
      teardown.step()
      expect(() => teardown.step()).toThrow(/teardown ran more than 1 Step/)
      const running = teardown.run(() => new Promise<never>(() => {}))
      const rejected = expect(running).rejects.toThrow(/teardown reached its 5ms Work limit/)

      await vi.advanceTimersByTimeAsync(5)

      await rejected
      recipe.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
