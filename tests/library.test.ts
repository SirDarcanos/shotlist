import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { discoverLibrary } from '../src/library.js'
import { projectPolicy } from '../src/run.js'

const made: string[] = []

/** Create a Project rooted in a temporary directory. */
function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shotlist-library-'))
  made.push(root)
  writeFileSync(join(root, 'shotlist.config.yaml'), 'site:\n  url: https://example.com\n')
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Library discovery', () => {
  it('returns ordered groups and readable documents without exposing authorized targets', () => {
    const root = project({
      'screenshots/recipes/z-last.yaml': 'clip: full',
      'screenshots/recipes/a-first.yaml': 'clip: viewport',
    })
    const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
    const trust = projectPolicy({ untrusted: false }, loaded).trust

    const discovery = discoverLibrary(loaded, trust)

    expect(discovery.groups.map((group) => group.kind)).toEqual(['macros', 'data', 'recipes'])
    const recipes = discovery.groups[2]!
    expect(recipes.file).toBe(join(root, 'screenshots/recipes'))
    expect(recipes.documents.map((document) => document.name)).toEqual(['a-first', 'z-last'])
    const first = recipes.documents[0]!
    expect(first).not.toHaveProperty('target')
    expect(Object.isFrozen(first)).toBe(true)
    expect('error' in first).toBe(false)
    if ('error' in first) throw first.error
    expect(first.read()).toEqual({ clip: 'viewport' })
  })

  it('retains a denied symlink as a countable entry with its authored path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'secret.yaml'), 'clip: viewport')
    const root = project()
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    symlinkSync(join(outside, 'secret.yaml'), join(root, 'screenshots/recipes/shared.yaml'))
    const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
    const trust = projectPolicy({ untrusted: true }, loaded).trust

    const recipes = discoverLibrary(loaded, trust).groups[2]!

    expect(recipes.documents).toHaveLength(1)
    expect(recipes.documents[0]).toMatchObject({
      name: 'shared',
      file: join(root, 'screenshots/recipes/shared.yaml'),
    })
    expect(recipes.documents[0]).toHaveProperty('error')
    expect(String((recipes.documents[0] as { error: unknown }).error)).toMatch(
      /paths\.recipes: .*outside the project/,
    )
  })

  it('records a refused directory while discovering the other Library groups', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'unread.yaml'), 'clip: viewport')
    const root = project({ 'screenshots/macros/open.yaml': 'steps: []' })
    symlinkSync(outside, join(root, 'screenshots/recipes'))
    const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
    const trust = projectPolicy({ untrusted: true }, loaded).trust

    const discovery = discoverLibrary(loaded, trust)

    expect(discovery.groups[0]!.documents.map((document) => document.name)).toEqual(['open'])
    expect(discovery.groups[2]).toMatchObject({
      file: join(root, 'screenshots/recipes'),
      documents: [],
    })
    const recipes = discovery.groups[2]!
    if (!('error' in recipes)) throw new Error('the recipes directory was expected to fail')
    expect(String(recipes.error)).toMatch(/paths\.recipes: .*outside the project/)
  })

  it('reads a symlinked document under an operator-granted path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'shared.yaml'), 'clip: viewport')
    const root = project()
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    symlinkSync(join(outside, 'shared.yaml'), join(root, 'screenshots/recipes/shared.yaml'))
    const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
    const trust = projectPolicy({ untrusted: true, paths: [outside] }, loaded).trust

    const [document] = discoverLibrary(loaded, trust).groups[2]!.documents

    expect(document).not.toHaveProperty('error')
    if (!document || 'error' in document) throw document?.error
    expect(document.read()).toEqual({ clip: 'viewport' })
  })

  it('checks forbidden names in a symlink target in trusted mode', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    mkdirSync(join(outside, '.git'))
    writeFileSync(join(outside, '.git/hidden.yaml'), 'clip: viewport')
    const root = project()
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    symlinkSync(join(outside, '.git/hidden.yaml'), join(root, 'screenshots/recipes/hidden.yaml'))
    const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
    const trust = projectPolicy({ untrusted: false }, loaded).trust

    const [document] = discoverLibrary(loaded, trust).groups[2]!.documents

    expect(document).toHaveProperty('error')
    expect(String((document as { error: unknown }).error)).toMatch(
      /paths\.recipes: "\.git" is a forbidden path/,
    )
  })
})
