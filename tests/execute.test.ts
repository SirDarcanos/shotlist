import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRun, shoot, writeBaseline } from '../src/index.js'
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

  it('validates Checking selection and preserves explicit or deterministic order', async () => {
    const root = tempProject()
    for (const name of ['annotated', 'modal', 'order-row']) {
      const file = join(root, 'recipes', `${name}.yaml`)
      writeFileSync(file, `${readFileSync(file, 'utf8')}\ncheck: false\n`)
    }
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))

    await expect(
      run.check({ recipes: ['modal', 'missing', 'modal', 'also-missing'] }),
    ).rejects.toThrow(/duplicate.*modal.*unknown.*also-missing.*missing/i)
    await expect(run.check({ recipes: [] })).rejects.toThrow(/at least one Recipe/)
    await expect(run.check({ all: true, recipes: ['modal'] } as never)).rejects.toThrow(
      /either.*recipes.*all/i,
    )

    const named = await run.check({ recipes: ['volatile', 'modal'] })
    const all = await run.check({ all: true })

    expect(named.results.map(({ name }) => name)).toEqual(['volatile', 'modal'])
    expect(all.results.map(({ name }) => name)).toEqual([
      'annotated',
      'modal',
      'order-row',
      'volatile',
    ])
  })

  it('returns same, changed, and new findings with drift, Ignore regions, and diffs', async () => {
    const root = tempProject()
    const recipeFile = join(root, 'recipes', 'order-row.yaml')
    writeFileSync(
      recipeFile,
      `${readFileSync(recipeFile, 'utf8')}\ncheck:\n  ignore: [{ within: clip, text: '$42.00' }]\n`,
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const recipe = run.project.library.recipes.get('order-row')!
    await shoot(run, recipe, { install: true })
    writeBaseline(run, { platform: 'a-different-platform' })

    const same = await run.check({ recipes: ['order-row'] })
    expect(same.results).toMatchObject([
      { name: 'order-row', status: 'same', ratio: 0, ignored: 1 },
    ])
    expect(same.drift).toMatchObject([
      { field: 'platform', was: 'a-different-platform', now: process.platform },
    ])

    copyFileSync(join(root, 'incoming', 'invoice.png'), join(root, 'installed', 'order-row.png'))
    const changed = await run.check({ recipes: ['order-row'], diff: true })
    expect(changed.results).toMatchObject([
      { name: 'order-row', status: 'changed', ignored: 1, diff: expect.any(String) },
    ])
    expect(existsSync(join(root, 'out', 'diff', 'order-row.png'))).toBe(true)

    unlinkSync(join(root, 'installed', 'order-row.png'))
    const added = await run.check({ recipes: ['order-row'] })
    expect(added.results).toMatchObject([{ name: 'order-row', status: 'new' }])
    expect(Object.isFrozen(added)).toBe(true)
    expect(Object.isFrozen(added.results)).toBe(true)
  }, 30_000)

  it('accounts for Checking failures, cleanup, stop-on-failure, and keep-going', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes', 'a-broken.yaml'),
      'install: guide\nsetup:\n  - click: { css: .missing-setup }\n' +
        'teardown:\n  - click: { css: .missing-teardown }\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const stopped = await run.check({ recipes: ['a-broken', 'order-row', 'volatile'] })
    expect(stopped.results).toMatchObject([
      { name: 'a-broken', status: 'failed' },
      { name: 'order-row', status: 'not-attempted' },
      { name: 'volatile', status: 'skipped' },
    ])
    const failed = stopped.results[0]!
    if (failed.status === 'failed') {
      expect(failed.error).toMatchObject({ message: expect.stringMatching(/setup/) })
      expect(failed.cleanupFailures).toMatchObject([{ message: expect.stringMatching(/teardown/) }])
    }

    const continued = await run.check({
      recipes: ['a-broken', 'volatile', 'order-row'],
      keepGoing: true,
    })
    expect(continued.results).toMatchObject([
      { name: 'a-broken', status: 'failed' },
      { name: 'volatile', status: 'skipped' },
      { name: 'order-row', status: 'new' },
    ])
  }, 30_000)

  it('reports Checking startup failures and remains reusable after overlap and settlement', async () => {
    const root = tempProject()
    const failedRun = openRun({ untrusted: false }, refuseSiteStartup(root))

    const failed = await failedRun.check({ recipes: ['order-row', 'volatile'] })
    expect(failed.results).toMatchObject([
      { name: 'order-row', status: 'not-attempted' },
      { name: 'volatile', status: 'skipped' },
    ])
    expect(failed.failures).toMatchObject([{ resource: 'site', stage: 'startup' }])
    expect(existsSync(join(root, 'out', 'order-row.png'))).toBe(false)

    const reusableRoot = tempProject()
    const run = openRun({ untrusted: false }, join(reusableRoot, 'shotlist.config.yaml'))
    const first = run.check({ recipes: ['order-row'] })
    await expect(run.capture({ recipes: ['modal'] })).rejects.toThrow(/already executing/)
    await expect(first).resolves.toMatchObject({
      results: [{ name: 'order-row', status: 'new' }],
    })
    await expect(run.check({ recipes: ['order-row'] })).resolves.toMatchObject({
      results: [{ name: 'order-row', status: 'new' }],
    })
  }, 30_000)

  it('reports a Baseline read failure without losing skipped findings', async () => {
    const root = tempProject()
    writeFileSync(join(root, 'shotlist.baseline.json'), '{not json')
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const failed = await run.check({ recipes: ['order-row', 'volatile'] })

    expect(failed.results).toMatchObject([
      { name: 'order-row', status: 'not-attempted' },
      { name: 'volatile', status: 'skipped' },
    ])
    expect(failed.failures).toMatchObject([{ resource: 'baseline', stage: 'read' }])
    expect(Object.isFrozen(failed.failures[0])).toBe(true)
    unlinkSync(join(root, 'shotlist.baseline.json'))
    await expect(run.check({ recipes: ['order-row'] })).resolves.toMatchObject({
      results: [{ name: 'order-row', status: 'new' }],
    })
  }, 30_000)

  it('returns skipped checking facts without starting resources', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))
    const result = await run.check({ recipes: ['volatile'] })

    expect(result).toEqual({
      drift: [],
      failures: [],
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
