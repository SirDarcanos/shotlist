import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeCheckRun } from '../src/execute.js'
import { openRun } from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

afterEach(removeProjects)

/** Make any attempt to start the configured site fail visibly. */
function refuseSiteStartup(root: string): string {
  const config = join(root, 'shotlist.config.yaml')
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace(
      'site:\n',
      'site:\n  serve:\n    command: shotlist-command-that-does-not-exist\n',
    ),
  )
  return config
}

describe('Run execution', () => {
  it('validates the complete Capture selection before starting resources', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))

    await expect(
      run.capture({ recipes: ['modal', 'missing', 'modal', 'also-missing'] }),
    ).rejects.toThrow(/duplicate.*modal.*unknown.*also-missing.*missing/i)
    await expect(run.capture({ recipes: [] })).rejects.toThrow(/at least one Recipe/)
    await expect(run.capture({ all: true, recipes: ['modal'] } as never)).rejects.toThrow(
      /either.*recipes.*all/i,
    )

    let reads = 0
    const request = {
      recipes: ['modal'],
      get keepGoing() {
        if (++reads > 1) throw new Error('request was read twice')
        return false
      },
    }
    await expect(run.capture(request)).resolves.toMatchObject({
      results: [{ name: 'modal', status: 'not-attempted' }],
    })
    expect(reads).toBe(1)
    await expect(run.capture({ recipes: ['modal'] })).resolves.toMatchObject({
      results: [{ name: 'modal', status: 'not-attempted' }],
    })
    expect(existsSync(join(root, 'out', 'modal.png'))).toBe(false)
  })

  it('selects named Recipes in caller order and all Recipes in name order', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const named = await run.capture({ recipes: ['volatile', 'modal'] })
    const all = await run.capture({ all: true })

    expect(named.results.map(({ name }) => name)).toEqual(['volatile', 'modal'])
    expect(named.results.map(({ status }) => status)).toEqual(['captured', 'captured'])
    expect(all.results.map(({ name }) => name)).toEqual([
      'annotated',
      'modal',
      'order-row',
      'volatile',
    ])
    expect(Object.isFrozen(named)).toBe(true)
    expect(Object.isFrozen(named.results)).toBe(true)
  }, 30_000)

  it('returns an empty report for all Recipes in an empty Library without resources', async () => {
    const root = tempProject()
    const recipes = join(root, 'recipes')
    for (const name of ['annotated', 'modal', 'order-row', 'volatile']) {
      writeFileSync(join(recipes, `${name}.yaml`), 'name: [invalid')
    }
    // An empty configured directory is needed because malformed documents cannot open a Run.
    const empty = join(root, 'empty-recipes')
    mkdirSync(empty)
    const config = refuseSiteStartup(root)
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace('recipes: recipes', 'recipes: empty-recipes'),
    )
    const run = openRun({ untrusted: false }, config)

    await expect(run.capture({ all: true })).resolves.toEqual({
      results: [],
      failures: [],
      operatorDestinations: [],
    })
    expect(existsSync(join(root, 'out', 'modal.png'))).toBe(false)
  })

  it('rejects overlap and accepts another Capture after settlement', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const first = run.capture({ recipes: ['modal'] })
    await expect(run.capture({ recipes: ['volatile'] })).rejects.toThrow(/already executing/)
    await expect(first).resolves.toMatchObject({ results: [{ name: 'modal', status: 'captured' }] })
    await expect(run.capture({ recipes: ['volatile'] })).resolves.toMatchObject({
      results: [{ name: 'volatile', status: 'captured' }],
    })
  }, 30_000)

  it('accounts for failures, stop-on-failure, keep-going, and completed Output images', async () => {
    const root = tempProject()
    writeFileSync(join(root, 'recipes', 'z-broken.yaml'), 'clip: { css: .never-there }\n')
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const stopped = await run.capture({ recipes: ['modal', 'z-broken', 'volatile'] })
    expect(stopped.results).toMatchObject([
      { name: 'modal', status: 'captured' },
      { name: 'z-broken', status: 'failed' },
      { name: 'volatile', status: 'not-attempted' },
    ])
    expect(existsSync(join(root, 'out', 'modal.png'))).toBe(true)

    const continued = await run.capture({
      recipes: ['z-broken', 'volatile'],
      keepGoing: true,
    })
    expect(continued.results).toMatchObject([
      { name: 'z-broken', status: 'failed' },
      { name: 'volatile', status: 'captured' },
    ])
  }, 30_000)

  it('retains a teardown failure without replacing the primary Capture failure', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes', 'double-failure.yaml'),
      'setup:\n  - click: { css: .missing-setup }\nteardown:\n  - click: { css: .missing-teardown }\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const report = await run.capture({ recipes: ['double-failure'] })
    const result = report.results[0]!

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error).toMatchObject({ message: expect.stringMatching(/setup/) })
      expect(result.cleanupFailures).toMatchObject([{ message: expect.stringMatching(/teardown/) }])
    }
  }, 30_000)

  it('returns a site startup failure with every Recipe not attempted', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))

    const report = await run.capture({ recipes: ['modal', 'volatile'] })

    expect(report.results).toMatchObject([
      { name: 'modal', status: 'not-attempted' },
      { name: 'volatile', status: 'not-attempted' },
    ])
    expect(report.failures).toMatchObject([{ resource: 'site' }])
    expect(existsSync(join(root, 'out', 'modal.png'))).toBe(false)
  })

  it('returns skipped checking facts without starting resources', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))
    const recipe = run.project.library.recipes.get('volatile')!

    const result = await executeCheckRun(run, [recipe])

    expect(result).toEqual({
      drift: [],
      operatorDestinations: [],
      results: [
        {
          name: 'volatile',
          status: 'skipped',
          reason: 'the recipe opts out of checking',
        },
      ],
    })
  })
})
