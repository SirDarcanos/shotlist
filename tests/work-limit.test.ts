import { describe, expect, it, vi } from 'vitest'
import { createRecipeWork, preflightRecipe, resolveWorkLimits } from '../src/work-limit.js'

describe('Recipe Work limits', () => {
  it('stops planning nested known loops once predictable work exceeds the limit', () => {
    const nested = (depth: number): unknown[] =>
      depth === 0
        ? [{ comment: 'leaf' }]
        : [{ each: '$items', as: `item${depth}`, steps: nested(depth - 1) }]
    const recipe = { setup: nested(4), teardown: [] }
    const library = {
      recipes: new Map([['nested', recipe]]),
      macros: new Map(),
      data: { items: Array.from({ length: 100 }, (_, index) => index) },
    }

    expect(() => preflightRecipe('nested', recipe, library)).toThrow(/would run/)
  })

  it('gives each retry a fresh actual-Step count', () => {
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
