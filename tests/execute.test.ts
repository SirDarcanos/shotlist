import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRun, writeBaseline } from '../src/index.js'
import type { RunProgress } from '../src/index.js'
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
    await expect(run.capture({ recipes: ['modal'], install: 'yes' } as never)).rejects.toThrow(
      /install.*boolean/i,
    )
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
    expect(named.installation).toEqual({
      results: [
        { name: 'volatile', status: 'not-requested' },
        { name: 'modal', status: 'not-requested' },
      ],
      baseline: { status: 'not-requested' },
    })
    expect(all.results.map(({ name }) => name)).toEqual([
      'annotated',
      'modal',
      'order-row',
      'volatile',
    ])
    expect(Object.isFrozen(named)).toBe(true)
    expect(Object.isFrozen(named.results)).toBe(true)
  }, 30_000)

  it('installs captured Recipes in order after Capture completes and records the Baseline', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const events: string[] = []

    const report = await run.capture({
      recipes: ['order-row', 'annotated'],
      install: true,
      onProgress: (progress) =>
        events.push(`${progress.type}:${'name' in progress ? progress.name : ''}`),
    })

    expect(report.results).toMatchObject([
      { name: 'order-row', status: 'captured' },
      { name: 'annotated', status: 'captured' },
    ])
    expect(report.installation.results).toEqual([
      {
        name: 'order-row',
        status: 'installed',
        file: join(root, 'installed', 'order-row.png'),
      },
      {
        name: 'annotated',
        status: 'installed',
        file: join(root, 'installed', 'annotated.png'),
      },
    ])
    expect(report.installation.baseline).toEqual({
      status: 'recorded',
      file: join(root, 'shotlist.baseline.json'),
    })
    expect(existsSync(join(root, 'installed', 'order-row.png'))).toBe(true)
    expect(existsSync(join(root, 'installed', 'annotated.png'))).toBe(true)
    expect(Object.isFrozen(report.installation)).toBe(true)
    expect(Object.isFrozen(report.installation.results)).toBe(true)
    expect(Object.isFrozen(report.installation.results[0])).toBe(true)
    expect(Object.isFrozen(report.installation.baseline)).toBe(true)
    expect(events).toEqual([
      'request-start:',
      'recipe-start:order-row',
      'recipe-complete:order-row',
      'recipe-start:annotated',
      'recipe-complete:annotated',
      'installation-start:order-row',
      'installation-complete:order-row',
      'installation-start:annotated',
      'installation-complete:annotated',
      'request-complete:',
    ])
  }, 30_000)

  it('withholds every Installation when a selected Capture fails', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes', 'z-broken.yaml'),
      'install: nowhere\nsetup:\n  - click: { css: .never-there }\n',
    )
    mkdirSync(join(root, 'installed'))
    const committed = join(root, 'installed', 'order-row.png')
    writeFileSync(committed, 'previous committed image')
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    writeBaseline(run, { platform: 'previous-platform' })
    const baseline = readFileSync(join(root, 'shotlist.baseline.json'), 'utf8')

    const report = await run.capture({
      recipes: ['order-row', 'z-broken'],
      install: true,
      keepGoing: true,
    })

    expect(report.results).toMatchObject([
      { name: 'order-row', status: 'captured' },
      { name: 'z-broken', status: 'failed' },
    ])
    expect(report.installation).toMatchObject({
      results: [
        { name: 'order-row', status: 'withheld', file: committed },
        { name: 'z-broken', status: 'withheld' },
      ],
      baseline: { status: 'not-recorded', reason: 'capture-withheld' },
    })
    expect(readFileSync(committed, 'utf8')).toBe('previous committed image')
    expect(readFileSync(join(root, 'shotlist.baseline.json'), 'utf8')).toBe(baseline)
    expect(existsSync(join(root, 'out', 'order-row.png'))).toBe(true)
  }, 30_000)

  it('stops after a failed safe replacement and preserves later Committed images', async () => {
    const root = tempProject()
    for (const name of ['first', 'second', 'third']) {
      writeFileSync(
        join(root, 'recipes', `${name}.yaml`),
        `name: ${name}\nsource: file\nfile: incoming/invoice.png\ninstall: guide\n`,
      )
    }
    mkdirSync(join(root, 'installed'))
    writeFileSync(join(root, 'installed', 'second.png'), 'previous second image')
    writeFileSync(join(root, 'installed', 'third.png'), 'previous third image')
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const report = await run.capture({
      recipes: ['first', 'second', 'third'],
      install: true,
      onProgress: (progress) => {
        if (progress.type === 'installation-start' && progress.name === 'second') {
          unlinkSync(join(root, 'out', 'second.png'))
        }
      },
    })

    expect(report.installation).toMatchObject({
      results: [
        { name: 'first', status: 'installed' },
        { name: 'second', status: 'failed', error: expect.anything() },
        { name: 'third', status: 'not-attempted' },
      ],
      baseline: { status: 'not-recorded', reason: 'installation-failed' },
    })
    expect(readFileSync(join(root, 'installed', 'second.png'), 'utf8')).toBe(
      'previous second image',
    )
    expect(readFileSync(join(root, 'installed', 'third.png'), 'utf8')).toBe('previous third image')
    expect(readdirSync(join(root, 'installed')).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(join(root, 'shotlist.baseline.json'))).toBe(false)
  }, 30_000)

  it('reports an invalid Install destination without losing completed Captures', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes', 'bad-install.yaml'),
      'name: bad-install\nsource: file\nfile: incoming/invoice.png\ninstall: nowhere\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const report = await run.capture({
      recipes: ['bad-install', 'annotated'],
      install: true,
    })

    expect(report.results).toMatchObject([
      { name: 'bad-install', status: 'captured' },
      { name: 'annotated', status: 'captured' },
    ])
    expect(report.installation).toMatchObject({
      results: [
        { name: 'bad-install', status: 'failed', error: expect.anything() },
        { name: 'annotated', status: 'not-attempted' },
      ],
      baseline: { status: 'not-recorded', reason: 'installation-failed' },
    })
    expect(existsSync(join(root, 'out', 'bad-install.png'))).toBe(true)
    expect(existsSync(join(root, 'installed', 'annotated.png'))).toBe(false)
  }, 30_000)

  it('reports a Recipe with no Install destination without recording a Baseline', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const report = await run.capture({ recipes: ['modal'], install: true })

    expect(report.installation).toEqual({
      results: [{ name: 'modal', status: 'no-destination' }],
      baseline: { status: 'not-recorded', reason: 'no-install-destination' },
    })
    expect(existsSync(join(root, 'out', 'modal.png'))).toBe(true)
    expect(existsSync(join(root, 'shotlist.baseline.json'))).toBe(false)
  }, 30_000)

  it('withholds Installation when cancellation follows the final Capture', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const controller = new AbortController()

    const report = await run.capture({
      recipes: ['annotated'],
      install: true,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.type === 'recipe-complete') controller.abort('stop before installing')
      },
    })

    expect(report.results).toMatchObject([{ name: 'annotated', status: 'captured' }])
    expect(report.installation).toMatchObject({
      results: [{ name: 'annotated', status: 'not-attempted' }],
      baseline: { status: 'not-recorded', reason: 'request-cancelled' },
    })
    expect(report.cancellation).toEqual({ reason: 'stop before installing' })
    expect(existsSync(join(root, 'out', 'annotated.png'))).toBe(true)
    expect(existsSync(join(root, 'installed', 'annotated.png'))).toBe(false)
  }, 30_000)

  it('cancels during Installation without claiming rollback of completed replacements', async () => {
    const root = tempProject()
    for (const name of ['first', 'second']) {
      writeFileSync(
        join(root, 'recipes', `${name}.yaml`),
        `name: ${name}\nsource: file\nfile: incoming/invoice.png\ninstall: guide\n`,
      )
    }
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const controller = new AbortController()

    const report = await run.capture({
      recipes: ['first', 'second'],
      install: true,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.type === 'installation-complete' && progress.name === 'first') {
          controller.abort('stop installing')
        }
      },
    })

    expect(report.installation).toMatchObject({
      results: [
        { name: 'first', status: 'installed' },
        { name: 'second', status: 'not-attempted', reason: 'request was cancelled' },
      ],
      baseline: { status: 'not-recorded', reason: 'request-cancelled' },
    })
    expect(report.cancellation).toEqual({ reason: 'stop installing' })
    expect(existsSync(join(root, 'installed', 'first.png'))).toBe(true)
    expect(existsSync(join(root, 'installed', 'second.png'))).toBe(false)
    expect(existsSync(join(root, 'shotlist.baseline.json'))).toBe(false)
  }, 30_000)

  it('reports a Baseline write failure without rolling back installed images', async () => {
    const root = tempProject()
    mkdirSync(join(root, 'shotlist.baseline.json'))
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const report = await run.capture({ recipes: ['annotated'], install: true })

    expect(report.installation.results).toMatchObject([{ name: 'annotated', status: 'installed' }])
    expect(report.installation.baseline).toMatchObject({
      status: 'failed',
      file: join(root, 'shotlist.baseline.json'),
      error: expect.anything(),
    })
    expect(existsSync(join(root, 'installed', 'annotated.png'))).toBe(true)
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
      installation: { results: [], baseline: { status: 'not-requested' } },
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
      'install: guide\nsetup:\n  - click: { css: .missing-setup }\nteardown:\n  - click: { css: .missing-teardown }\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    const report = await run.capture({ recipes: ['double-failure'], install: true })
    const result = report.results[0]!

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error).toMatchObject({ message: expect.stringMatching(/setup/) })
      expect(result.cleanupFailures).toMatchObject([{ message: expect.stringMatching(/teardown/) }])
    }
    expect(report.installation).toMatchObject({
      results: [{ name: 'double-failure', status: 'withheld' }],
      baseline: { status: 'not-recorded', reason: 'capture-withheld' },
    })
  }, 30_000)

  it('returns a site startup failure with every Recipe not attempted', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))

    const report = await run.capture({ recipes: ['modal', 'volatile'], install: true })

    expect(report.results).toMatchObject([
      { name: 'modal', status: 'not-attempted' },
      { name: 'volatile', status: 'not-attempted' },
    ])
    expect(report.failures).toMatchObject([{ resource: 'site' }])
    expect(report.installation).toMatchObject({
      results: [
        { name: 'modal', status: 'no-destination' },
        { name: 'volatile', status: 'withheld' },
      ],
      baseline: { status: 'not-recorded', reason: 'capture-withheld' },
    })
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
    await run.capture({ recipes: ['order-row'], install: true })
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

  it('accounts for pre-cancelled requests without starting resources', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))
    const controller = new AbortController()
    controller.abort({ source: 'caller' })

    const captured = await run.capture({
      recipes: ['modal', 'volatile'],
      install: true,
      signal: controller.signal,
    })
    expect(captured.results).toMatchObject([
      { name: 'modal', status: 'not-attempted', reason: 'request was cancelled' },
      { name: 'volatile', status: 'not-attempted', reason: 'request was cancelled' },
    ])
    expect(captured.failures).toEqual([])
    expect(captured.installation).toMatchObject({
      results: [
        { name: 'modal', status: 'no-destination' },
        { name: 'volatile', status: 'not-attempted' },
      ],
      baseline: { status: 'not-recorded', reason: 'request-cancelled' },
    })
    expect(captured.cancellation?.reason).toBe(controller.signal.reason)

    const checked = await run.check({
      recipes: ['order-row', 'volatile'],
      signal: controller.signal,
    })
    expect(checked.results).toMatchObject([
      { name: 'order-row', status: 'not-attempted', reason: 'request was cancelled' },
      { name: 'volatile', status: 'skipped' },
    ])
    expect(checked.failures).toEqual([])
    expect(existsSync(join(root, 'out', 'modal.png'))).toBe(false)
  })

  it('cancels browser work, retains teardown failure, accounts for remaining Recipes, and reuses the Run', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes', 'slow.yaml'),
      'install: guide\nretries: 2\nsetup:\n  - wait: 10000\nteardown:\n  - click: { css: .missing-teardown }\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const controller = new AbortController()
    let retries = 0

    const report = await run.capture({
      recipes: ['slow', 'modal'],
      install: true,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.type === 'recipe-start') {
          setTimeout(() => controller.abort('caller stopped'), 50)
        }
        if (progress.type === 'retry') retries++
      },
    })

    expect(report.results).toMatchObject([
      {
        name: 'slow',
        status: 'cancelled',
        reason: 'caller stopped',
        cleanupFailures: [{ message: expect.stringMatching(/teardown/) }],
      },
      { name: 'modal', status: 'not-attempted', reason: 'request was cancelled' },
    ])
    expect(report.installation).toMatchObject({
      results: [
        { name: 'slow', status: 'not-attempted' },
        { name: 'modal', status: 'no-destination' },
      ],
      baseline: { status: 'not-recorded', reason: 'request-cancelled' },
    })
    expect(report.cancellation).toEqual({ reason: 'caller stopped' })
    expect(retries).toBe(0)
    await expect(run.capture({ recipes: ['modal'] })).resolves.toMatchObject({
      results: [{ name: 'modal', status: 'captured' }],
    })
  }, 30_000)

  it('cancels active Checking and accounts for later Recipes', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes', 'slow-check.yaml'),
      'install: guide\nsetup:\n  - wait: 10000\nteardown:\n  - wait: 1\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const controller = new AbortController()

    const report = await run.check({
      recipes: ['slow-check', 'order-row'],
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.type === 'recipe-start') {
          setTimeout(() => controller.abort('checking stopped'), 50)
        }
      },
    })

    expect(report.results).toMatchObject([
      { name: 'slow-check', status: 'cancelled', reason: 'checking stopped' },
      { name: 'order-row', status: 'not-attempted', reason: 'request was cancelled' },
    ])
    expect(report.cancellation).toEqual({ reason: 'checking stopped' })
  }, 30_000)

  it('awaits ordered Capture progress through retries and isolates observer failures', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes', 'retry.yaml'),
      'retries: 1\nsetup:\n  - click: { css: .missing }\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const events: RunProgress[] = []

    const retryReport = await run.capture({
      recipes: ['retry'],
      onProgress: async (progress) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(progress)
      },
    })

    expect(retryReport.results).toMatchObject([{ name: 'retry', status: 'failed' }])
    expect(events.map(({ type }) => type)).toEqual([
      'request-start',
      'recipe-start',
      'retry',
      'recipe-complete',
      'request-complete',
    ])
    expect(events[0]).toMatchObject({
      operation: 'capture',
      recipes: ['retry'],
    })
    expect(events[1]).toMatchObject({ name: 'retry', index: 0, total: 1 })
    expect(events[2]).toMatchObject({ name: 'retry', attempt: 1, of: 2, why: expect.any(String) })
    expect(events[3]).toMatchObject({
      name: 'retry',
      result: { name: 'retry', status: 'failed' },
    })
    expect(Object.isFrozen(events[3])).toBe(true)
    if (events[3]?.type === 'recipe-complete') {
      expect(Object.isFrozen(events[3].result)).toBe(true)
      expect(events[3].result).toBe(retryReport.results[0])
    }

    const observed: string[] = []
    const completed = await run.capture({
      recipes: ['modal'],
      onProgress: (progress) => {
        observed.push(progress.type)
        if (progress.type === 'recipe-start') throw new Error('observer broke')
      },
    })
    expect(completed.results).toMatchObject([{ name: 'modal', status: 'captured' }])
    expect(observed).toEqual(['request-start', 'recipe-start'])
    expect(completed.warnings).toEqual(['Progress observer failed: observer broke'])
  }, 30_000)

  it('emits ordered Checking progress for skipped Recipes', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))
    const seen: string[] = []

    const result = await run.check({
      recipes: ['volatile'],
      onProgress: (progress) => seen.push(`${progress.operation}:${progress.type}`),
    })

    expect(result.results).toMatchObject([{ name: 'volatile', status: 'skipped' }])
    expect(seen).toEqual([
      'check:request-start',
      'check:recipe-start',
      'check:recipe-complete',
      'check:request-complete',
    ])
  })

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
