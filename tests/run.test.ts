import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRun } from '../src/index.js'
import { networkPolicyFor } from '../src/run.js'
import type { Run } from '../src/index.js'
import { runSteps } from '../src/steps.js'
import type { RunContext } from '../src/steps.js'

if (false) {
  // @ts-expect-error Operator authority is a required part of the Run interface.
  openRun()
}

const made: string[] = []

/** Create a Project rooted in a temporary directory. */
function project(config: Record<string, unknown>, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shotlist-run-'))
  made.push(root)
  writeFileSync(join(root, 'shotlist.config.json'), JSON.stringify(config))
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

/** The smallest valid config for opening a Run. */
function config(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { site: { url: 'https://example.com' }, ...extra }
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('openRun', () => {
  it('requires Operator authority at runtime', () => {
    const call = openRun as unknown as (authority?: unknown, file?: string) => unknown
    expect(() => call()).toThrow(/Operator authority is required/)
    expect(() => call({}, 'shotlist.config.yaml')).toThrow(/untrusted.*boolean/)
  })

  it('stops Executed Steps at the Run-owned Work limit', async () => {
    const root = project(config())
    const run = openRun(
      { untrusted: false, workLimits: { executedSteps: 1 } },
      join(root, 'shotlist.config.json'),
    )
    const context = { page: {}, vars: {}, rects: {} } as unknown as RunContext
    const steps = [
      { step: { optional: [] }, vars: {}, nested: [] },
      { step: { optional: [] }, vars: {}, nested: [] },
    ]

    await expect(runSteps(run, steps, context)).rejects.toThrow(
      /ran more than 1 Step; the Work limit is 1/,
    )
  })

  it('rejects forged Runs before touching their browser context', async () => {
    const root = project(config())
    const authentic = openRun({ untrusted: false }, join(root, 'shotlist.config.json'))
    let touched = false
    const context = {
      get page() {
        touched = true
        throw new Error('browser context was touched')
      },
    } as unknown as RunContext
    const forged = [{ project: authentic.project }, { ...authentic }] as unknown as Run[]

    for (const candidate of forged) {
      await expect(runSteps(candidate, [], context)).rejects.toThrow(
        /A Run opened by shotlist is required/,
      )
    }
    expect(touched).toBe(false)
  })

  it('applies Operator-owned Work limits while opening the Library', () => {
    const root = project(config(), {
      'screenshots/recipes/long.yaml': `setup:
  - click: { css: .first }
  - click: { css: .second }
`,
    })

    expect(() =>
      openRun(
        { untrusted: false, workLimits: { authoredSteps: 1 } },
        join(root, 'shotlist.config.json'),
      ),
    ).toThrow(/2 authored Steps; the Work limit is 1/)
  })

  it('rejects predictable loop work before a Run can start browser work', () => {
    const root = project(config(), {
      'screenshots/recipes/loop.yaml': `setup:
  - repeat: 2
    steps:
      - click: { css: .first }
      - click: { css: .second }
`,
    })

    expect(() =>
      openRun(
        { untrusted: false, workLimits: { executedSteps: 4 } },
        join(root, 'shotlist.config.json'),
      ),
    ).toThrow(/would run 5 Steps; the Work limit is 4/)
  })

  it('counts deliberate waits before running a Recipe', () => {
    const root = project(config(), {
      'screenshots/recipes/wait.yaml': 'setup:\n  - wait: 5\n',
    })

    expect(() =>
      openRun(
        { untrusted: false, workLimits: { recipeMilliseconds: 4 } },
        join(root, 'shotlist.config.json'),
      ),
    ).toThrow(/would deliberately wait 5ms; the Work limit is 4ms/)
  })

  it('rejects predictable teardown waits before browser work', () => {
    const root = project(config(), {
      'screenshots/recipes/slow-cleanup.yaml': 'teardown:\n  - wait: 2\n',
    })

    expect(() =>
      openRun(
        { untrusted: false, workLimits: { teardownMilliseconds: 1 } },
        join(root, 'shotlist.config.json'),
      ),
    ).toThrow(/teardown would deliberately wait 2ms/)
  })

  it('preflights a Macro before scripted sign-in can open a browser', () => {
    const root = project(config(), {
      'screenshots/macros/long.yaml': `steps:
  - repeat: 2
    steps:
      - click: { css: .first }
      - click: { css: .second }
`,
    })

    expect(() =>
      openRun(
        { untrusted: false, workLimits: { executedSteps: 4 } },
        join(root, 'shotlist.config.json'),
      ),
    ).toThrow(/macro "long" would run 5 Steps/)
  })

  it('lets only Operator authority raise the numerical matching length', () => {
    const root = project(config(), {
      'screenshots/recipes/pattern.yaml': JSON.stringify({
        marks: { long: { matching: 'a'.repeat(300) } },
      }),
    })
    const file = join(root, 'shotlist.config.json')

    expect(() => openRun({ untrusted: false }, file)).toThrow(/more than 256 characters/)
    expect(() =>
      openRun({ untrusted: false, workLimits: { matchingCharacters: 400 } }, file),
    ).not.toThrow()
  })

  it('checks matching patterns in Project Finders before browser work', () => {
    const root = project(config({ finders: { danger: { matching: '(a+)+$' } } }))

    expect(() => openRun({ untrusted: false }, join(root, 'shotlist.config.json'))).toThrow(
      /cannot run safely/,
    )
  })

  it('opens a complete Project in trusted mode', () => {
    const root = project(config(), {
      'screenshots/macros/sign-in.yaml': 'steps: [{ click: { text: Sign in } }]',
      'screenshots/data/users.json': '{"name":"Ada"}',
      'screenshots/recipes/home.yaml': 'clip: viewport',
    })

    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.json'))

    expect(run.project.root).toBe(root)
    expect([...run.project.library.macros.keys()]).toEqual(['sign-in'])
    expect(run.project.library.data).toEqual({ users: { name: 'Ada' } })
    expect([...run.project.library.recipes.keys()]).toEqual(['home'])
    expect(run.trust.untrusted).toBe(false)
  })

  it('authorizes every Library directory before enumerating one', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-outside-'))
    made.push(outside)
    const root = project(config({ paths: { macros: 'not-a-directory', recipes: outside } }), {
      'not-a-directory': 'nothing to enumerate',
    })

    // `macros` sorts first and cannot be enumerated. The later policy failure still wins
    // because every directory is authorized before the first one reaches the filesystem.
    expect(() => openRun({ untrusted: true }, join(root, 'shotlist.config.json'))).toThrow(
      /^paths\.recipes: .*outside the project/,
    )
  })

  it('authorizes every discovered document before reading one', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'secret.yaml'), 'clip: viewport')
    const root = project(config(), { 'screenshots/recipes/a-broken.yaml': 'name: [not valid' })
    symlinkSync(join(outside, 'secret.yaml'), join(root, 'screenshots/recipes/z-secret.yaml'))

    expect(() => openRun({ untrusted: true }, join(root, 'shotlist.config.json'))).toThrow(
      /^paths\.recipes: .*outside the project/,
    )
  })

  it('reads authorized documents before assembling the Library', () => {
    const root = project(config(), {
      'screenshots/recipes/a-invalid-schema.yaml': 'name: [wrong]\n',
      'screenshots/recipes/z-invalid-syntax.yaml': 'name: [not closed\n',
    })

    // Discovery reads raw documents before `parseLibrary` validates their language, so
    // the later syntax error remains the first failure as it was before this refactor.
    expect(() => openRun({ untrusted: false }, join(root, 'shotlist.config.json'))).toThrow(
      /z-invalid-syntax\.yaml/,
    )
  })

  it('preserves trusted config grants and ignores them in untrusted mode', () => {
    const root = project(
      config({ site: { url: 'https://example.com', allow: ['accounts.example.test'] } }),
    )
    const file = join(root, 'shotlist.config.json')

    expect(openRun({ untrusted: false }, file).operatorDestinations).toEqual([])
    expect(openRun({ untrusted: true }, file).operatorDestinations).toEqual([])
    expect(
      openRun({ untrusted: true, destinations: ['operator.example.test'] }, file)
        .operatorDestinations,
    ).toContainEqual({
      protocol: 'https:',
      host: 'operator.example.test',
      port: 443,
      subdomains: false,
    })
  })

  it('uses trusted Project approvals and gives an untrusted Project none', () => {
    const root = project(
      config({
        site: {
          url: 'http://example.com:8080/app',
          allow: ['assets.example.com', '*.static.example.com'],
        },
      }),
    )
    const file = join(root, 'shotlist.config.json')
    const trusted = networkPolicyFor(openRun({ untrusted: false }, file))
    const untrusted = networkPolicyFor(openRun({ untrusted: true }, file))

    expect(() => trusted.forOperation('test').check('http://example.com:8080/next')).not.toThrow()
    expect(() => trusted.forOperation('test').check('https://assets.example.com/')).not.toThrow()
    expect(() => trusted.forOperation('test').check('https://a.static.example.com/')).not.toThrow()
    expect(() => trusted.forOperation('test').check('https://static.example.com/')).toThrow()
    expect(() => untrusted.forOperation('test').check('http://example.com:8080/')).toThrow()
  })

  it('applies protected SHOTLIST_WORK_LIMITS settings', () => {
    const previous = process.env['SHOTLIST_WORK_LIMITS']
    process.env['SHOTLIST_WORK_LIMITS'] = 'authoredSteps=1'
    try {
      const root = project(config(), {
        'screenshots/recipes/long.yaml': `setup:\n  - click: { css: .first }\n  - click: { css: .second }\n`,
      })
      expect(() => openRun({ untrusted: false }, join(root, 'shotlist.config.json'))).toThrow(
        /2 authored Steps; the Work limit is 1/,
      )
    } finally {
      if (previous === undefined) delete process.env['SHOTLIST_WORK_LIMITS']
      else process.env['SHOTLIST_WORK_LIMITS'] = previous
    }
  })

  it('merges protected SHOTLIST_ALLOW approvals into Operator authority', () => {
    const previous = process.env['SHOTLIST_ALLOW']
    process.env['SHOTLIST_ALLOW'] = 'ci.example.com, https://staging.example.com:8443'
    try {
      const root = project(config())
      const run = openRun({ untrusted: true }, join(root, 'shotlist.config.json'))
      expect(run.operatorDestinations).toEqual([
        { protocol: 'https:', host: 'ci.example.com', port: 443, subdomains: false },
        { protocol: 'https:', host: 'staging.example.com', port: 8443, subdomains: false },
      ])
    } finally {
      if (previous === undefined) delete process.env['SHOTLIST_ALLOW']
      else process.env['SHOTLIST_ALLOW'] = previous
    }
  })

  it('publishes snapshots that stay stable for the Run lifetime', () => {
    const grantedHosts = ['first.example.test']
    const previous = process.env['SHOTLIST_RUN_VALUE']
    process.env['SHOTLIST_RUN_VALUE'] = 'before'
    try {
      const root = project(config({ allowEnv: ['SHOTLIST_RUN_VALUE'] }), {
        'screenshots/data/settings.json': '{"nested":{"value":1}}',
        'screenshots/recipes/home.yaml': 'clip: viewport',
      })
      const file = join(root, 'shotlist.config.json')
      const run = openRun({ untrusted: false, destinations: grantedHosts }, file)

      grantedHosts.push('later.example.test')
      process.env['SHOTLIST_RUN_VALUE'] = 'after'
      writeFileSync(file, JSON.stringify(config({ site: { url: 'https://changed.example' } })))
      writeFileSync(join(root, 'screenshots/data/settings.json'), '{"nested":{"value":2}}')

      expect(run.authority.destinations).toEqual(['first.example.test'])
      expect(run.operatorDestinations).not.toContainEqual(
        expect.objectContaining({ host: 'later.example.test' }),
      )
      expect(run.env).toEqual({ SHOTLIST_RUN_VALUE: 'before' })
      expect(run.project.config.site.url).toBe('https://example.com')
      expect(run.project.library.data).toEqual({ settings: { nested: { value: 1 } } })
      expect(Object.isFrozen(run.project.config.site)).toBe(true)
      expect(Object.isFrozen(run.project.library.data['settings'])).toBe(true)
      expect(() => (run.project.library.recipes as Map<string, unknown>).set('later', {})).toThrow()
    } finally {
      if (previous === undefined) delete process.env['SHOTLIST_RUN_VALUE']
      else process.env['SHOTLIST_RUN_VALUE'] = previous
    }
  })

  it('freezes a data document named __proto__ as an ordinary Library entry', () => {
    const root = project(config(), {
      ['screenshots/data/__proto__.json']: '{"nested":{"value":1}}',
    })

    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.json'))
    const value = run.project.library.data['__proto__']

    expect(Object.keys(run.project.library.data)).toEqual(['__proto__'])
    expect(value).toEqual({ nested: { value: 1 } })
    expect(Object.isFrozen(value)).toBe(true)
  })

  it('does not expose a partial Run when a Project document is malformed', () => {
    const root = project(config(), { 'screenshots/recipes/broken.yaml': 'name: [not valid' })
    let run: ReturnType<typeof openRun> | undefined

    expect(() => {
      run = openRun({ untrusted: false }, join(root, 'shotlist.config.json'))
    }).toThrow(/broken\.yaml/)
    expect(run).toBeUndefined()
    expect(readFileSync(join(root, 'screenshots/recipes/broken.yaml'), 'utf8')).toContain(
      'not valid',
    )
  })
})
