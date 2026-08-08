import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import type { Io } from '../src/cli.js'
import { removeProjects, tempProject } from './tempProject.js'

const project = tempProject

/** Run the command line, collecting what it printed. */
async function cli(root: string, args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) }
  const code = await run([...args, '--config', join(root, 'shotlist.config.yaml')], io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

afterEach(removeProjects)

describe('shotlist', () => {
  it('lists the recipes when given nothing to do', async () => {
    const { code, out } = await cli(project(), [])
    expect(code).toBe(0)
    expect(out.split('\n')).toEqual(['annotated', 'modal', 'order-row', 'volatile'])
  })

  it('names the recipes a project has when one is misspelled', async () => {
    const { code, err } = await cli(project(), ['order-rows'])
    expect(code).toBe(1)
    expect(err).toMatch(/unknown recipe "order-rows".*annotated, modal, order-row, volatile/s)
  })

  it('shoots a named recipe and installs it', { timeout: 120_000 }, async () => {
    const root = project()
    const { code, out } = await cli(root, ['order-row', '--install'])
    expect(code).toBe(0)
    expect(out).toContain('✓ order-row')
    expect(existsSync(join(root, 'out/order-row.png'))).toBe(true)
    expect(existsSync(join(root, 'installed/order-row.png'))).toBe(true)
  })

  it('shoots everything with --all', { timeout: 120_000 }, async () => {
    const root = project()
    const { code } = await cli(root, ['--all'])
    expect(code).toBe(0)
    expect(existsSync(join(root, 'out/order-row.png'))).toBe(true)
    expect(existsSync(join(root, 'out/modal.png'))).toBe(true)
  })

  it('prints usage on --help without touching the project', async () => {
    const { code, out } = await cli(project(), ['--help'])
    expect(code).toBe(0)
    expect(out).toContain('shotlist --check')
  })

  it('refuses an unknown flag rather than ignoring it', async () => {
    const { code, err } = await cli(project(), ['--intsall'])
    expect(code).toBe(1)
    expect(err).toContain('--intsall')
  })
})

// A project shoots its whole set in one run, and one recipe that cannot be shot should
// not decide whether the other thirty-nine get taken.
describe('--keep-going', () => {
  /** Add a recipe to a project that no page can satisfy. Sorts first, so it fails first. */
  function withBroken(root: string): string {
    writeFileSync(
      join(root, 'recipes/broken.yaml'),
      'name: broken\ninstall: guide\nmarks:\n  nowhere: { css: .no-such-element }\n',
    )
    return root
  }

  it('stops at the first failure without it', { timeout: 120_000 }, async () => {
    const root = withBroken(project())
    const { code, err } = await cli(root, ['--all'])
    expect(code).toBe(1)
    expect(err).toMatch(/recipe "broken": marks\.nowhere/)
    // order-row sorts after broken, so a run that stopped never reached it.
    expect(existsSync(join(root, 'out/order-row.png'))).toBe(false)
  })

  it(
    'shoots the rest, then names what failed and exits non-zero',
    { timeout: 120_000 },
    async () => {
      const root = withBroken(project())
      const { code, out, err } = await cli(root, ['--all', '--keep-going'])
      expect(code).toBe(1)
      expect(out).toContain('✓ order-row')
      expect(existsSync(join(root, 'out/order-row.png'))).toBe(true)
      expect(err).toContain('1 of 5 failed: broken')
    },
  )

  it(
    'carries a failure through --check as a result, not an abort',
    { timeout: 120_000 },
    async () => {
      const root = withBroken(project())
      await cli(root, ['order-row', '--install'])
      const { code, out } = await cli(root, ['--check', '--all', '--keep-going'])
      expect(code).toBe(1)
      expect(out).toMatch(/FAILED {3}broken — recipe "broken": marks\.nowhere/)
      expect(out).toContain('same     order-row')
    },
  )

  it('says which attempt failed while a recipe is retrying', { timeout: 120_000 }, async () => {
    const root = withBroken(project())
    const file = join(root, 'recipes/broken.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}retries: 2\n`)
    const { code, out } = await cli(root, ['broken', '--keep-going'])
    expect(code).toBe(1)
    expect(out).toContain('↻ broken — attempt 1 of 3 failed: marks.nowhere')
    expect(out).toContain('↻ broken — attempt 2 of 3 failed: marks.nowhere')
    // Two retry lines for three attempts: the last is a failure, not a retry.
    expect(out.match(/↻/g)).toHaveLength(2)
  })
})

// The point of a mask: a shot holding one thing the recipe does not decide stays
// checkable, instead of having to opt out of `--check` altogether.
describe('mask', () => {
  const recipe = (extra = '') => `name: plain\ninstall: guide\nclip: viewport\n${extra}`

  it('covers the region it names, and no more of the shot than that', async () => {
    const root = project()
    const file = join(root, 'recipes/plain.yaml')
    writeFileSync(file, recipe())
    await cli(root, ['plain', '--install'])

    writeFileSync(file, recipe('mask: [{ css: .bar }]\n'))
    const { code, out } = await cli(root, ['--check', 'plain'])

    expect(code).toBe(1)
    // `.bar` is 1000×60 of a 1000×700 viewport — 8.6% of the pixels. A mask that painted
    // more than it was given, or landed in the wrong place, would not land in this range.
    const percent = Number(/([\d.]+)% of pixels differ/.exec(out)![1])
    expect(percent).toBeGreaterThan(7.5)
    expect(percent).toBeLessThan(9.5)
  }, 120_000)

  it('names the mask that matched nothing', async () => {
    const root = project()
    writeFileSync(join(root, 'recipes/plain.yaml'), recipe('mask: [{ css: .nowhere }]\n'))
    const { code, err } = await cli(root, ['plain'])
    expect(code).toBe(1)
    expect(err).toMatch(/recipe "plain": mask\[0\] — no element matched/)
  }, 120_000)
})

describe('the machine a baseline was taken on', () => {
  it('is recorded when images are installed, and read back on a check', async () => {
    const root = project()
    const { out } = await cli(root, ['order-row', '--install'])
    expect(out).toContain('recorded this machine in shotlist.baseline.json')

    const file = join(root, 'shotlist.baseline.json')
    const recorded = JSON.parse(readFileSync(file, 'utf8'))
    expect(recorded.platform).toBe(process.platform)
    expect(recorded.chromium).toMatch(/^\d+\./)

    // The same machine: nothing to say.
    const same = await cli(root, ['--check', 'order-row'])
    expect(same.out).not.toContain('not the machine')

    // A baseline from somewhere else: the drift is named before the results, so a
    // moved pixel is not read as the site having changed.
    writeFileSync(file, JSON.stringify({ ...recorded, chromium: '1.0.0', platform: 'aix' }))
    const moved = await cli(root, ['--check', 'order-row'])
    expect(moved.out).toContain('not the machine the committed images were taken on')
    expect(moved.out).toMatch(/chromium: 1\.0\.0 → \d+\./)
    expect(moved.out).toContain(`platform: aix → ${process.platform}`)
  }, 120_000)

  it('is not written by a run that installs nothing', async () => {
    const root = project()
    await cli(root, ['order-row'])
    expect(existsSync(join(root, 'shotlist.baseline.json'))).toBe(false)
  }, 120_000)
})

describe('--check', () => {
  it('reports a recipe with nothing committed as new, and exits non-zero', async () => {
    const root = project()
    const { code, out } = await cli(root, ['--check', 'order-row'])
    expect(code).toBe(1)
    expect(out).toContain('NEW      order-row')
    expect(out).toContain('1 of 1 need attention')
  })

  it('reports an unchanged screenshot as the same', { timeout: 120_000 }, async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    const { code, out } = await cli(root, ['--check', 'order-row'])
    expect(code).toBe(0)
    expect(out).toContain('same     order-row')
    expect(out).toContain('every screenshot is current')
  })

  it('reports a screenshot whose page has moved on as changed', { timeout: 120_000 }, async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    // Overwrite the committed image with a different recipe's, which is what a UI
    // change looks like from here: the same name, a different picture.
    await cli(root, ['modal'])
    cpSync(join(root, 'out/modal.png'), join(root, 'installed/order-row.png'))

    const { code, out } = await cli(root, ['--check', 'order-row'])
    expect(code).toBe(1)
    expect(out).toMatch(/CHANGED {2}order-row — size changed/)
  })

  it('skips a recipe that opts out, whatever is committed for it', async () => {
    const root = project()
    await cli(root, ['volatile', '--install'])
    const { code, out } = await cli(root, ['--check', 'volatile'])
    expect(code).toBe(0)
    expect(out).toContain('skipped  volatile')
    expect(out).toContain('opts out of checking')
  })

  it('honours a threshold the recipe sets for itself', { timeout: 120_000 }, async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    // A threshold of 0 calls any difference at all a change; the shot is stable, so this
    // proves the recipe's own number is the one being used rather than the project's.
    const file = join(root, 'recipes/order-row.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\ncheck: { threshold: 0, tolerance: 0 }\n`)
    const { out } = await cli(root, ['--check', 'order-row'])
    expect(out).toMatch(/same|CHANGED/)
  })

  it('skips a recipe that installs nowhere, since there is nothing to compare', async () => {
    const { code, out } = await cli(project(), ['--check', 'modal'])
    expect(code).toBe(0)
    expect(out).toContain('skipped  modal')
    expect(out).toContain('installs nowhere')
  })
})
