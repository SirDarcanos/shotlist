import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { countLibraryDocuments, openLibrary, reviewLibrary } from '../src/library.js'
import { projectPolicy } from '../src/run.js'
import { resolveWorkLimits } from '../src/work-limit.js'

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

/** Load one Project and derive its policy for a Library operation. */
function under(root: string, untrusted: boolean, paths: readonly string[] = []) {
  const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
  const trust = projectPolicy({ untrusted, paths }, loaded).trust
  return { loaded, trust }
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Library opening', () => {
  it('publishes one complete immutable Library in stable filename order', () => {
    const root = project({
      'screenshots/macros/open.yaml': 'steps: []',
      'screenshots/data/user.json': '{"name":"Ada"}',
      'screenshots/recipes/z-last.yaml': 'clip: full',
      'screenshots/recipes/a-first.yaml': 'clip: viewport',
    })
    const { loaded, trust } = under(root, false)

    const library = openLibrary(loaded, trust)

    expect([...library.macros.keys()]).toEqual(['open'])
    expect(library.data).toEqual({ user: { name: 'Ada' } })
    expect([...library.recipes.keys()]).toEqual(['a-first', 'z-last'])
    expect(Object.isFrozen(library.data['user'])).toBe(true)
    expect(() => (library.recipes as Map<string, unknown>).set('later', {})).toThrow()
  })

  it('refuses an oversized Recipe before parsing it', () => {
    const root = project({
      'screenshots/recipes/large.yaml': 'name: [unfinished',
    })
    const { loaded, trust } = under(root, false)

    expect(() => openLibrary(loaded, trust, resolveWorkLimits({ recipeBytes: 8 }))).toThrow(
      /Recipe is larger than 8 bytes; the Work limit is 8/,
    )
  })

  it('opens a document symlinked through an operator-granted path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'shared.yaml'), 'clip: viewport')
    const root = project()
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    symlinkSync(join(outside, 'shared.yaml'), join(root, 'screenshots/recipes/shared.yaml'))
    const { loaded, trust } = under(root, true, [outside])

    const library = openLibrary(loaded, trust)

    expect([...library.recipes.keys()]).toEqual(['shared'])
  })

  it('refuses a secret-looking symlink target in trusted mode', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    mkdirSync(join(outside, '.git'))
    writeFileSync(join(outside, '.git/hidden.yaml'), 'clip: viewport')
    const root = project()
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    symlinkSync(join(outside, '.git/hidden.yaml'), join(root, 'screenshots/recipes/hidden.yaml'))
    const { loaded, trust } = under(root, false)

    expect(() => openLibrary(loaded, trust)).toThrow(/paths\.recipes: "\.git" is a forbidden path/)
  })

  it('reports an authored document path when its authorized target cannot be read', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    const root = project()
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    const authored = join(root, 'screenshots/recipes/missing.yaml')
    symlinkSync(join(outside, 'missing.yaml'), authored)
    const { loaded, trust } = under(root, false)

    let message = ''
    try {
      openLibrary(loaded, trust)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(authored)
    expect(message).not.toContain(outside)
  })
})

describe('Library review', () => {
  it('retains a refused document as a countable problem at its authored path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'secret.yaml'), 'clip: viewport')
    const root = project()
    mkdirSync(join(root, 'screenshots/recipes'), { recursive: true })
    const authored = join(root, 'screenshots/recipes/shared.yaml')
    symlinkSync(join(outside, 'secret.yaml'), authored)
    const { loaded, trust } = under(root, true)

    const review = reviewLibrary(loaded, trust)

    expect(review.documents).toBe(1)
    expect(review.problems).toHaveLength(1)
    expect(review.problems[0]).toMatchObject({ file: authored, level: 'error' })
    expect(review.problems[0]!.message).toMatch(/paths\.recipes: .*outside the project/)
  })

  it('warns when a Library document reaches eighty percent of its Work limit', () => {
    const root = project({ 'screenshots/recipes/near.yaml': 'clip: viewport\n' })
    const { loaded, trust } = under(root, false)

    const review = reviewLibrary(loaded, trust, {}, resolveWorkLimits({ recipeBytes: 18 }))

    expect(review.problems).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringMatching(/15 bytes.*18/) }),
    ])
  })

  it('warns when authored Steps reach eighty percent of their Work limit', () => {
    const steps = Array.from(
      { length: 8 },
      (_, index) => `  - click: { css: .item-${index} }`,
    ).join('\n')
    const root = project({ 'screenshots/recipes/near.yaml': `setup:\n${steps}\n` })
    const { loaded, trust } = under(root, false)

    const review = reviewLibrary(loaded, trust, {}, resolveWorkLimits({ authoredSteps: 10 }))

    expect(review.problems).toEqual([
      expect.objectContaining({
        file: join(root, 'screenshots/recipes/near.yaml'),
        level: 'warning',
        message: expect.stringMatching(/8 authored Steps.*Work limit.*10/),
      }),
    ])
  })

  it('reports predictable loop work without starting a Run', () => {
    const root = project({
      'screenshots/recipes/loop.yaml': `setup:
  - repeat: 2
    steps:
      - click: { css: .first }
      - click: { css: .second }
`,
    })
    const { loaded, trust } = under(root, false)

    const review = reviewLibrary(loaded, trust, {}, resolveWorkLimits({ executedSteps: 4 }))

    expect(review.problems).toEqual([
      expect.objectContaining({
        level: 'error',
        message: expect.stringMatching(/would run 5 Steps/),
      }),
    ])
  })

  it('continues through other Library directories after one cannot be enumerated', () => {
    const root = project({
      'screenshots/macros/open.yaml': 'steps: []',
      'screenshots/recipes': 'not a directory',
    })
    const { loaded, trust } = under(root, false)

    const review = reviewLibrary(loaded, trust)

    expect(review.documents).toBe(1)
    expect(review.problems).toHaveLength(1)
    expect(review.problems[0]).toMatchObject({
      file: join(root, 'screenshots/recipes'),
      level: 'error',
    })
  })

  it('keeps an authorized directory target out of enumeration diagnostics', () => {
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-library-outside-'))
    made.push(outside)
    const target = join(outside, 'not-a-directory')
    writeFileSync(target, 'not a directory')
    const root = project()
    mkdirSync(join(root, 'screenshots'), { recursive: true })
    const authored = join(root, 'screenshots/recipes')
    symlinkSync(target, authored)
    const { loaded, trust } = under(root, true, [outside])

    const review = reviewLibrary(loaded, trust)

    expect(review.problems[0]!.file).toBe(authored)
    expect(review.problems[0]!.message).toContain(authored)
    expect(review.problems[0]!.message).not.toContain(outside)
  })

  it('counts inventory without reading malformed documents', () => {
    const root = project({
      'screenshots/recipes/broken.yaml': 'name: [not closed',
      'screenshots/recipes/.hidden.yaml': 'clip: viewport',
      'screenshots/recipes/readme.txt': 'not a recipe',
    })
    const { loaded, trust } = under(root, false)

    expect(countLibraryDocuments(loaded, trust)).toBe(1)
  })
})
