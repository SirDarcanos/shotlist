import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import type { Io } from '../src/cli.js'
import { removeProjects, tempProject } from './tempProject.js'

const project = tempProject

/** A PNG's pixel size, read from its header. */
function pngSize(file: string): { width: number; height: number } {
  const png = readFileSync(file)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** Run the command line, collecting what it printed. */
async function cli(root: string, args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) }
  const code = await run([...args, '--config', join(root, 'shotlist.config.yaml')], io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const made: string[] = []

afterEach(() => {
  removeProjects()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

// A percentage says a shot moved. It does not say what moved, which is the thing you
// actually need before deciding whether to bless it.
// The first five minutes: a project with no config, and a README to copy from.
describe('--init', () => {
  /** An empty directory, and the CLI pointed at a config inside it. */
  function blank() {
    const root = mkdtempSync(join(tmpdir(), 'shotlist-init-'))
    made.push(root)
    return { root, config: join(root, 'shotlist.config.yaml') }
  }

  it('writes a config and a recipe that the tool can then read', async () => {
    const { root, config } = blank()
    const io = { out: (line: string) => lines.push(line), err: () => {} }
    const lines: string[] = []
    expect(await run(['--init', '--config', config], io)).toBe(0)

    expect(existsSync(config)).toBe(true)
    expect(existsSync(join(root, 'screenshots/recipes/example.yaml'))).toBe(true)

    // The scaffold has to parse: one that does not is worse than none at all.
    const listed = await cli(root, [])
    expect(listed.code).toBe(0)
    expect(listed.out).toBe('example')
  })

  it('leaves anything already there alone', async () => {
    const { root, config } = blank()
    writeFileSync(config, 'site: { url: http://example.test }\n')
    const io = { out: (line: string) => lines.push(line), err: () => {} }
    const lines: string[] = []
    await run(['--init', '--config', config], io)

    expect(readFileSync(config, 'utf8')).toBe('site: { url: http://example.test }\n')
    expect(lines.join('\n')).toContain('already there')
    // The half that was missing is still written.
    expect(existsSync(join(root, 'screenshots/recipes/example.yaml'))).toBe(true)
  })
})

describe('--diff', () => {
  /** Install order-row, then make what is committed for it a different picture. */
  async function drifted(width: 'same' | 'other') {
    const root = project()
    await cli(root, ['order-row', '--install'])
    await cli(root, [width === 'same' ? 'order-row' : 'modal'])
    if (width === 'other') {
      cpSync(join(root, 'out/modal.png'), join(root, 'installed/order-row.png'))
    } else {
      // Same size, different pixels: mask a region of the committed image.
      writeFileSync(
        join(root, 'recipes/order-row.yaml'),
        `${readFileSync(join(root, 'recipes/order-row.yaml'), 'utf8')}mask: [{ within: clip, text: $42.00 }]\n`,
      )
    }
    return root
  }

  it('writes a before/after/changed image beside the shot, and names it', async () => {
    const root = await drifted('same')
    const { code, out } = await cli(root, ['--check', 'order-row', '--diff'])
    expect(code).toBe(1)
    const file = join(root, 'out/diff/order-row.png')
    expect(out).toContain(`diff:      ${file}`)
    expect(existsSync(file)).toBe(true)

    // Three panels and two gaps across, one panel tall — the shot, twice over, plus
    // the same again with the moved pixels tinted.
    const shot = pngSize(join(root, 'out/order-row.png'))
    const diff = pngSize(file)
    expect(diff.width).toBe(shot.width * 3 + 12 * 2)
    expect(diff.height).toBe(shot.height)
  }, 120_000)

  it('shows two panels when the sizes differ, since pixels cannot be overlaid', async () => {
    const root = await drifted('other')
    await cli(root, ['--check', 'order-row', '--diff'])
    const committed = pngSize(join(root, 'installed/order-row.png'))
    const reshot = pngSize(join(root, 'out/order-row.png'))
    const diff = pngSize(join(root, 'out/diff/order-row.png'))
    expect(diff.width).toBe(committed.width + reshot.width + 12)
    expect(diff.height).toBe(Math.max(committed.height, reshot.height))
  }, 120_000)

  it('writes nothing for a shot that did not move', async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    const { code } = await cli(root, ['--check', 'order-row', '--diff'])
    expect(code).toBe(0)
    expect(existsSync(join(root, 'out/diff/order-row.png'))).toBe(false)
  }, 120_000)
})

// A CI job wants to branch on what a check found, not parse the lines a person reads.
describe('--check --json', () => {
  it('puts the report on stdout and everything else on stderr', async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    const { code, out, err } = await cli(root, ['--check', 'order-row', '--json'])

    expect(code).toBe(0)
    // stdout has to be a usable file on its own: `--check --json > report.json`.
    const report = JSON.parse(out)
    expect(report).toMatchObject({ changed: 0, total: 1 })
    expect(report.results[0]).toMatchObject({ name: 'order-row', status: 'same' })
    expect(typeof report.results[0].ratio).toBe('number')

    // The human report moved aside rather than being dropped.
    expect(err).toContain('same     order-row')
    expect(out).not.toContain('same     order-row')
  }, 120_000)

  it('carries the drift and the diff a run found', async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    const file = join(root, 'shotlist.baseline.json')
    const recorded = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...recorded, platform: 'aix' }))
    writeFileSync(
      join(root, 'recipes/order-row.yaml'),
      `${readFileSync(join(root, 'recipes/order-row.yaml'), 'utf8')}mask: [{ within: clip, text: $42.00 }]\n`,
    )

    const { code, out } = await cli(root, ['--check', 'order-row', '--json', '--diff'])
    expect(code).toBe(1)
    const report = JSON.parse(out)
    expect(report.changed).toBe(1)
    expect(report.drift).toContainEqual({ field: 'platform', was: 'aix', now: process.platform })
    expect(report.results[0].diff).toBe(join(root, 'out/diff/order-row.png'))
  }, 120_000)

  it('refuses to be asked for a report of a run that takes screenshots', async () => {
    const { code, err } = await cli(project(), ['order-row', '--json'])
    expect(code).toBe(1)
    expect(err).toContain('--json reports a --check run')
  })
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
