import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { formatOf } from '../src/image.js'
import { run } from '../src/cli.js'
import type { Io } from '../src/cli.js'
import { removeProjects, tempProject } from './tempProject.js'

const SITE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fixture/site.html')).href

/** Run the command line against a project, collecting what it printed. */
async function cli(root: string, args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) }
  const code = await run([...args, '--config', join(root, 'shotlist.config.yaml')], io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** A project pointed at the product page, with whatever recipes the test needs. */
function project(recipes: Record<string, string>): string {
  const root = tempProject()
  writeFileSync(
    join(root, 'shotlist.config.yaml'),
    `site:\n  url: ${SITE}\n  viewport: { width: 1100, height: 850 }\n  scale: 1\n` +
      'paths: { recipes: recipes, macros: macros, data: data, out: out }\n' +
      'install: { guide: installed }\n' +
      'finders:\n  plan:\n    heading: $1\n    ancestor: { widerThan: 200, minChildren: 2 }\n',
  )
  for (const name of ['order-row', 'modal', 'volatile', 'annotated']) {
    writeFileSync(join(root, `recipes/${name}.yaml`), 'name: unused\nclip: viewport\n')
  }
  for (const [name, body] of Object.entries(recipes)) {
    writeFileSync(join(root, `recipes/${name}.yaml`), body)
  }
  return root
}

const size = (file: string) => {
  const png = readFileSync(file)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

afterEach(removeProjects)

// The other fixture exercises query primitives against hand-written rects. This one is a
// page shaped like the ones recipes are actually written for, shot in a real browser.
describe('a page shaped like a real one', () => {
  it(
    'reaches a pricing card by its heading and calls parts of it out',
    { timeout: 120_000 },
    async () => {
      const root = project({
        pricing: [
          'name: pricing',
          'install: guide',
          'clip: { plan: Team, pad: 12 }',
          'marks:',
          '  price: { within: clip, css: .price }',
          '  blurb: { within: clip, css: p }',
          'callouts:',
          '  - { mark: price, text: What it costs }',
          '  - { mark: blurb, text: What you get }',
          '',
        ].join('\n'),
      })
      const { code, out } = await cli(root, ['pricing', '--install'])
      expect(code).toBe(0)
      expect(out).toContain('✓ pricing')

      // The card, not the whole grid and not the heading inside it.
      const shot = size(join(root, 'out/pricing.png'))
      expect(shot.width).toBeGreaterThan(200)
      expect(shot.width).toBeLessThan(500)
    },
  )

  it('drives the page before shooting it', { timeout: 120_000 }, async () => {
    const root = project({
      signup: [
        'name: signup',
        'setup:',
        '  - hover: { testid: signup }',
        '  - click: { role: button, name: Book a walkthrough }',
        'clip: { css: .hero, pad: 8 }',
        'marks: { cta: { testid: signup } }',
        '',
      ].join('\n'),
    })
    const { code, err } = await cli(root, ['signup'])
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(existsSync(join(root, 'out/signup.png'))).toBe(true)
  })

  // The table's "last seen" column is redrawn on every load, which is the case both of
  // these exist for — one hides it, the other only excuses it from the comparison.
  it('masks every cell that changes, not just the first', { timeout: 120_000 }, async () => {
    const root = project({
      events: [
        'name: events',
        'install: guide',
        'clip: { css: table, pad: 8 }',
        'mask: [{ css: .seen }]',
        '',
      ].join('\n'),
    })
    await cli(root, ['events', '--install'])
    const { code, out } = await cli(root, ['--check', 'events'])
    expect(code).toBe(0)
    expect(out).toContain('same     events')
  })

  it('checks the table around a cell it cannot predict', { timeout: 120_000 }, async () => {
    const root = project({
      events: [
        'name: events',
        'install: guide',
        'clip: { css: table, pad: 8 }',
        'check:',
        '  ignore: [{ css: .seen }]',
        '',
      ].join('\n'),
    })
    await cli(root, ['events', '--install'])
    const { code, out } = await cli(root, ['--check', 'events'])
    expect(code).toBe(0)
    expect(out).toContain('same     events  (2 regions not compared)')
  })

  it(
    'reports the same table without the exclusion, since the cell moved on',
    {
      timeout: 120_000,
    },
    async () => {
      const root = project({
        // Any difference at all counts here. The cell is three digits in a fixed-width
        // column, so two loads can differ by one glyph — under the default threshold,
        // which would make this pass or fail on which numbers came up.
        events: [
          'name: events',
          'install: guide',
          'clip: { css: table, pad: 8 }',
          'check: { threshold: 0, tolerance: 0 }',
          '',
        ].join('\n'),
      })
      await cli(root, ['events', '--install'])
      const { code, out } = await cli(root, ['--check', 'events'])
      expect(code).toBe(1)
      expect(out).toContain('CHANGED  events')
    },
  )
})

// A screenshot only reaches past the fold with `fullPage`, and Playwright clamps a clip
// to the viewport without it — so `clip: full` quietly returned one viewport, and the
// tall half of every page was never in the picture.
describe('a shot taller than the viewport', () => {
  const size = (file: string) => {
    const png = readFileSync(file)
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }

  it('reaches the bottom of the page with clip: full', { timeout: 120_000 }, async () => {
    const root = project({ whole: 'name: whole\nclip: full\n' })
    await cli(root, ['whole'])
    // The page is a hero, a plans grid, a table and a footer: several viewports of it.
    const shot = size(join(root, 'out/whole.png'))
    expect(shot.height).toBeGreaterThan(850)
  })

  it(
    'keeps a region that runs past the fold, rather than trimming it',
    {
      timeout: 120_000,
    },
    async () => {
      // `.wrap` holds the whole page, so its box is far taller than the 850 it is shot at.
      const root = project({ tall: 'name: tall\nclip: { css: .wrap }\n' })
      await cli(root, ['tall'])
      expect(size(join(root, 'out/tall.png')).height).toBeGreaterThan(850)
    },
  )

  it('still marks the right region in one that does', { timeout: 120_000 }, async () => {
    // Marks are measured against the viewport and the clip against the page, so a shot
    // this tall is where the two disagree if the offset is wrong.
    const root = project({
      deep: [
        'name: deep',
        'clip: full',
        'marks: { credits: { css: .credits } }',
        'callouts: [{ mark: credits, text: Who made it }]',
        '',
      ].join('\n'),
    })
    const { code, err } = await cli(root, ['deep'])
    expect(err).toBe('')
    expect(code).toBe(0)
  })
})

// A screenshot of an interface is mostly text, which is the thing JPEG treats worst and
// WebP treats about as well as PNG for a good deal fewer bytes.
describe('the format a shot is written in', () => {
  it('writes each one, under the name it is known by', { timeout: 120_000 }, async () => {
    const root = project({
      'as-png': 'name: as-png\nclip: viewport\n',
      'as-jpeg': 'name: as-jpeg\nformat: jpeg\nclip: viewport\n',
      'as-webp': 'name: as-webp\nformat: webp\nclip: viewport\n',
    })
    const { code } = await cli(root, ['as-png', 'as-jpeg', 'as-webp'])
    expect(code).toBe(0)

    // The bytes, not the name: a browser asked for a format it cannot write answers with
    // a PNG, and that would land here under the wrong extension without a word.
    for (const [file, format] of [
      ['out/as-png.png', 'png'],
      ['out/as-jpeg.jpg', 'jpeg'],
      ['out/as-webp.webp', 'webp'],
    ] as const) {
      expect(formatOf(readFileSync(join(root, file))), file).toBe(format)
    }
  })

  it(
    'checks a shot against the committed file of the same format',
    { timeout: 120_000 },
    async () => {
      const root = project({
        shot: 'name: shot\ninstall: guide\nformat: webp\nclip: { css: table, pad: 8 }\ncheck: { ignore: [{ css: .seen }] }\n',
      })
      await cli(root, ['shot', '--install'])
      expect(existsSync(join(root, 'installed/shot.webp'))).toBe(true)
      const { code, out } = await cli(root, ['--check', 'shot'])
      expect(code).toBe(0)
      expect(out).toContain('same     shot')
    },
  )
})
