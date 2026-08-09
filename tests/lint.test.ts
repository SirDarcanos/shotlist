import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lint, parseRecipe, run } from '../src/index.js'

const made: string[] = []
afterAll(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A project on disk, from a map of paths to contents. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shotlist-lint-'))
  made.push(root)
  writeFileSync(
    join(root, 'shotlist.config.yaml'),
    files['shotlist.config.yaml'] ??
      `site:\n  url: http://localhost:3000\npaths:\n  recipes: recipes\n  macros: macros\n  data: data\ninstall:\n  guide: images\n`,
  )
  for (const [name, contents] of Object.entries(files)) {
    if (name === 'shotlist.config.yaml') continue
    const file = join(root, name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

const config = (root: string) => join(root, 'shotlist.config.yaml')

describe('a key that is nearly right', () => {
  it('names the one that was meant, rather than every branch that failed', () => {
    expect(() => parseRecipe({ name: 'r', clip: { css: '.row', marching: 'Acme' } })).toThrow(
      /unknown key "marching" — did you mean "matching"\?/,
    )
  })

  it('says it once — the literal branches of `clip` are not failed attempts at a mapping', () => {
    let message = ''
    try {
      parseRecipe({ name: 'r', clip: { css: '.row', marching: 'Acme' } })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toMatch(/expected "viewport"/)
    expect(message).not.toMatch(/expected "full"/)
    expect(message.split('\n').filter((line) => line.includes('marching'))).toHaveLength(1)
  })

  it('offers nothing when nothing is close, rather than the nearest of a bad lot', () => {
    expect(() => parseRecipe({ name: 'r', clip: { css: '.row', wombat: 1 } })).toThrow(
      /unknown key "wombat"$/m,
    )
  })

  it('suggests a config key too', () => {
    const root = project({
      'shotlist.config.yaml': 'site:\n  url: http://x.test\n  viewpoint: 3\n',
    })
    expect(lint(config(root))[0]?.message).toMatch(/did you mean "viewport"\?/)
  })
})

describe('--lint', () => {
  it('reports every file, rather than stopping at the first that fails', () => {
    const root = project({
      'recipes/one.yaml': `name: one\nclip: { css: '.a', marching: 'x' }\n`,
      'recipes/two.yaml': `name: two\nclip: { css: '.b', mathcing: 'y' }\n`,
      'macros/m.yaml': `steps:\n  - clik: { css: 'button' }\n`,
    })
    const problems = lint(config(root))
    expect(problems).toHaveLength(3)
    expect(problems.every((one) => one.level === 'error')).toBe(true)
    expect(problems.map((one) => one.message).join('\n')).toMatch(/did you mean "click"\?/)
  })

  it('reports a config that will not load, rather than throwing out of the run', () => {
    const root = project({ 'shotlist.config.yaml': 'site: {}\n' })
    const problems = lint(config(root))
    expect(problems).toHaveLength(1)
    expect(problems[0]!.level).toBe('error')
  })

  it('catches YAML that does not parse at all', () => {
    const root = project({ 'data/rows.yaml': 'a: [1, 2\n' })
    expect(lint(config(root))[0]?.file).toMatch(/rows\.yaml$/)
  })

  it('finds nothing wrong with a project that is fine', () => {
    const root = project({
      'recipes/ok.yaml': `name: ok\nclip: viewport\nmarks:\n  a: { css: '.a' }\ncallouts:\n  - { mark: a, text: Here }\n`,
    })
    expect(lint(config(root))).toEqual([])
  })
})

describe('warnings', () => {
  const suspect = () =>
    project({
      'recipes/ok.yaml': `name: ok\nclip: viewport\nmarks:\n  a: { css: '.a' }\n  b: { css: '.b' }\ncallouts:\n  - { mark: a, text: Here }\ninstall: nowhere\n`,
    })

  it('are off unless asked for, so a lint run reports only what is refused', () => {
    expect(lint(config(suspect()))).toEqual([])
  })

  it('name a mark no callout points at, and a destination the config does not have', () => {
    const found = lint(config(suspect()), { warnings: true })
    expect(found.every((one) => one.level === 'warning')).toBe(true)
    expect(found.map((one) => one.message)).toEqual([
      'mark "b" is never used by a callout',
      'install: "nowhere" is not a destination the config names',
    ])
  })
})

describe('the exit code', () => {
  const say = () => {
    const lines: string[] = []
    return { io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, lines }
  }

  it('is non-zero when something is refused', async () => {
    const root = project({ 'recipes/one.yaml': `name: one\nclip: { css: '.a', marching: 'x' }\n` })
    const { io, lines } = say()
    expect(await run(['--lint', '--config', config(root)], io)).toBe(1)
    expect(lines.join('\n')).toMatch(/1 error in 2 files/)
  })

  it('is zero for a clean project, and says so', async () => {
    const root = project({ 'recipes/ok.yaml': `name: ok\nclip: viewport\n` })
    const { io, lines } = say()
    expect(await run(['--lint', '--config', config(root)], io)).toBe(0)
    expect(lines.join('\n')).toMatch(/nothing wrong in 2 files/)
  })

  it('stays zero when only warnings were found, so they cannot fail a build', async () => {
    const root = project({
      'recipes/ok.yaml': `name: ok\nclip: viewport\nmarks:\n  a: { css: '.a' }\n`,
    })
    const { io, lines } = say()
    expect(await run(['--lint', '--warnings', '--config', config(root)], io)).toBe(0)
    expect(lines.join('\n')).toMatch(/0 errors, 1 warning/)
  })
})
