import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRun } from '../src/index.js'

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
    const root = project(config({ paths: { data: outside } }), {
      'screenshots/recipes/broken.yaml': 'name: [not valid',
    })

    expect(() => openRun({ untrusted: true }, join(root, 'shotlist.config.json'))).toThrow(
      /^paths\.data: .*outside the project/,
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

  it('allows a symlinked document under an operator-granted path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'shared.yaml'), 'clip: viewport')
    const root = project(config())
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    symlinkSync(join(outside, 'shared.yaml'), join(root, 'screenshots/recipes/shared.yaml'))

    const run = openRun({ untrusted: true, paths: [outside] }, join(root, 'shotlist.config.json'))

    expect(run.project.library.recipes.has('shared')).toBe(true)
  })

  it('checks forbidden names in a symlink target in trusted mode', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-outside-'))
    made.push(outside)
    mkdirSync(join(outside, '.git'), { recursive: true })
    writeFileSync(join(outside, '.git/recipe.yaml'), 'clip: viewport')
    const root = project(config())
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    symlinkSync(join(outside, '.git/recipe.yaml'), join(root, 'screenshots/recipes/hidden.yaml'))

    expect(() => openRun({ untrusted: false }, join(root, 'shotlist.config.json'))).toThrow(
      /^paths\.recipes: "\.git" is a forbidden path/,
    )
  })

  it('preserves trusted config grants and ignores them in untrusted mode', () => {
    const root = project(
      config({ site: { url: 'https://example.com', allow: ['accounts.example.test'] } }),
    )
    const file = join(root, 'shotlist.config.json')

    expect(openRun({ untrusted: false }, file).trust.hosts).toContain('accounts.example.test')
    expect(openRun({ untrusted: true }, file).trust.hosts).not.toContain('accounts.example.test')
    expect(
      openRun({ untrusted: true, hosts: ['operator.example.test'] }, file).trust.hosts,
    ).toContain('operator.example.test')
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
      const run = openRun({ untrusted: false, hosts: grantedHosts }, file)

      grantedHosts.push('later.example.test')
      process.env['SHOTLIST_RUN_VALUE'] = 'after'
      writeFileSync(file, JSON.stringify(config({ site: { url: 'https://changed.example' } })))
      writeFileSync(join(root, 'screenshots/data/settings.json'), '{"nested":{"value":2}}')

      expect(run.authority.hosts).toEqual(['first.example.test'])
      expect(run.trust.hosts).not.toContain('later.example.test')
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
