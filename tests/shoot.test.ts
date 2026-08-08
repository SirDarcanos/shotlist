import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  drawAnnotations,
  loadConfig,
  loadLibrary,
  loadPlaywright,
  parseConfig,
  shoot,
  withNumbering,
} from '../src/index.js'
import type { LoadedConfig } from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

/** A throwaway copy of the fixture project, loaded through the public API. */
function project(): { loaded: LoadedConfig; library: ReturnType<typeof loadLibrary> } {
  const root = tempProject()
  const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
  const { paths, finders } = loaded.config
  const library = loadLibrary({
    recipes: join(root, paths.recipes),
    macros: join(root, paths.macros),
    data: join(root, paths.data),
    finders,
  })
  return { loaded, library }
}

/** A PNG's pixel size, read from its header. */
function pngSize(file: string): { width: number; height: number } {
  const png = readFileSync(file)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

afterAll(removeProjects)

describe('shoot', () => {
  it(
    'drives the page, clips a region, draws the callouts and installs the image',
    { timeout: 120_000 },
    async () => {
      const { loaded, library } = project()
      const recipe = withNumbering(library.recipes.get('order-row')!)
      const result = await shoot(recipe, library, loaded, { install: true })

      expect(existsSync(result.file)).toBe(true)
      expect(result.installed).toMatch(/installed\/order-row\.png$/)
      expect(existsSync(result.installed!)).toBe(true)

      // The canvas is wider than the clip because a label sits in a margin on each side.
      const clipWidth = 400 + 12 * 2
      expect(result.size.width).toBeGreaterThan(clipWidth)
      const pixels = pngSize(result.file)
      expect(pixels.width).toBe(result.size.width * 2)
    },
  )

  it('numbers marks in the order the recipe lists them', { timeout: 120_000 }, async () => {
    const { loaded, library } = project()
    const recipe = withNumbering(library.recipes.get('modal')!)
    expect(recipe.callouts.map((c) => [c.mark, c.n])).toEqual([
      ['bar', 1],
      ['detail', 2],
      ['actions', 3],
    ])

    const result = await shoot(recipe, library, loaded)
    expect(existsSync(result.file)).toBe(true)
    // The top bar runs edge to edge, so its box and its disc would both be sliced by
    // the shot's own boundary — the canvas grows instead.
    expect(result.size.width).toBeGreaterThan(1000)
    expect(result.size.height).toBeGreaterThan(700)
  })

  it('refuses an install destination the config never named', async () => {
    const { loaded, library } = project()
    const recipe = { ...library.recipes.get('modal')!, install: 'nowhere' }
    await expect(shoot(recipe, library, loaded, { install: true })).rejects.toThrow(
      /installs to "nowhere".*it defines guide/s,
    )
  })
})

// A query is resolved by a function serialized into the browser, so a failure arrives as
// `page.evaluateHandle: Error: …` with a JavaScript stack through `UtilityScript`. The
// person reading it is editing YAML: it has to say which recipe, and which key in it.
describe('a query that matches nothing', () => {
  /** Shoot `order-row` with one key replaced, and return the error it threw. */
  async function failure(patch: Record<string, unknown>): Promise<Error> {
    const { loaded, library } = project()
    const recipe = { ...library.recipes.get('order-row')!, ...patch }
    return shoot(recipe, library, loaded).then(
      () => {
        throw new Error('the shot was expected to fail')
      },
      (error: Error) => error,
    )
  }

  const nowhere = { css: '.no-such-thing-anywhere' }

  it('names the recipe and the mark', { timeout: 120_000 }, async () => {
    const error = await failure({ marks: { amount: nowhere }, callouts: [] })
    expect(error.message).toBe(
      'recipe "order-row": marks.amount — no element matched {"css":".no-such-thing-anywhere"}',
    )
  })

  it('names the clip', { timeout: 120_000 }, async () => {
    const error = await failure({ clip: nowhere, marks: {}, callouts: [] })
    expect(error.message).toMatch(/^recipe "order-row": clip — no element matched /)
  })

  it('names the step that could not find its element', { timeout: 120_000 }, async () => {
    const error = await failure({ setup: [{ click: nowhere }], marks: {}, callouts: [] })
    expect(error.message).toMatch(/^recipe "order-row": setup — `click`: no element matched /)
  })

  it("keeps Playwright's own wrapping out of it", { timeout: 120_000 }, async () => {
    const error = await failure({ marks: { amount: nowhere }, callouts: [] })
    expect(error.message).not.toMatch(/evaluateHandle|UtilityScript|\n\s+at /)
  })
})

describe('a site that is not up', () => {
  it('names the key holding the url, and asks whether it is running', async () => {
    const { loaded, library } = project()
    // Port 1 is reserved, so nothing can be listening on it and the connection is
    // refused rather than left to time out.
    const recipe = { ...library.recipes.get('order-row')!, url: 'http://127.0.0.1:1/' }
    await expect(shoot(recipe, library, loaded)).rejects.toThrow(
      /^recipe "order-row": `url` — could not open http:\/\/127\.0\.0\.1:1\/ — .*Is the site running\?$/s,
    )
  }, 120_000)
})

// A capture drives a real application, so some of what it trips over is gone a second
// later. `retries` is the recipe saying which of its shots are like that.
describe('retries', () => {
  /** A browser that fails every context, counting how many were asked for. */
  function broken() {
    const contexts: number[] = []
    return {
      contexts,
      browser: {
        newContext: () => {
          contexts.push(contexts.length + 1)
          return Promise.reject(new Error('the context could not be opened'))
        },
        close: () => Promise.resolve(),
      },
    }
  }

  it('shoots once when the recipe asks for no retries', async () => {
    const { loaded, library } = project()
    const { browser, contexts } = broken()
    const recipe = library.recipes.get('order-row')!
    await expect(shoot(recipe, library, loaded, { browser })).rejects.toThrow()
    expect(contexts.length).toBe(1)
  })

  it('shoots one more time per retry, and no more', async () => {
    const { loaded, library } = project()
    const { browser, contexts } = broken()
    const recipe = { ...library.recipes.get('order-row')!, retries: 2 }
    await expect(shoot(recipe, library, loaded, { browser })).rejects.toThrow(
      'the context could not be opened',
    )
    expect(contexts.length).toBe(3)
  })

  it('reports each failed attempt as it happens, with what went wrong', async () => {
    const { loaded, library } = project()
    const { browser } = broken()
    const seen: string[] = []
    const recipe = { ...library.recipes.get('order-row')!, retries: 2 }
    await expect(
      shoot(recipe, library, loaded, {
        browser,
        onRetry: (retry) => seen.push(`${retry.attempt}/${retry.of} ${retry.why}`),
      }),
    ).rejects.toThrow()
    // Two reports, not three: the last attempt is a failure, not a retry.
    expect(seen).toEqual([
      '1/3 the context could not be opened',
      '2/3 the context could not be opened',
    ])
  })

  it('returns the shot when a later attempt succeeds', { timeout: 120_000 }, async () => {
    const { loaded, library } = project()
    const real = await loadPlaywright().chromium.launch()
    let contexts = 0
    // Fails once, then behaves. Nothing about the recipe is wrong, which is the case
    // `retries` exists for: the same shot taken again is the whole fix.
    const flaky = {
      newContext: (options?: Record<string, unknown>) =>
        ++contexts === 1 ? Promise.reject(new Error('a flake')) : real.newContext(options as never),
      close: () => Promise.resolve(),
    }
    const recipe = { ...library.recipes.get('order-row')!, retries: 1 }
    try {
      const result = await shoot(recipe, library, loaded, { browser: flaky })
      expect(existsSync(result.file)).toBe(true)
    } finally {
      await real.close()
    }
  })

  it('never retries `source: file`, which has no page to be flaky about', async () => {
    const { loaded, library } = project()
    const seen: string[] = []
    const recipe = {
      ...library.recipes.get('annotated')!,
      file: 'incoming/not-here.png',
      retries: 3,
    }
    await expect(
      shoot(recipe, library, loaded, {
        browser: {
          newContext: () => Promise.reject(new Error('a browser was used')),
          close: () => Promise.resolve(),
        },
        onRetry: (retry) => seen.push(retry.why),
      }),
    ).rejects.toThrow(/no file at /)
    expect(seen).toEqual([])
  })
})

describe('source: file', () => {
  it(
    'annotates an image already on disk, with no page to query',
    { timeout: 120_000 },
    async () => {
      const { loaded, library } = project()
      const recipe = withNumbering(library.recipes.get('annotated')!)
      const result = await shoot(recipe, library, loaded, { install: true })

      expect(existsSync(result.file)).toBe(true)
      expect(existsSync(result.installed!)).toBe(true)

      // The source is 600×280 image pixels, which is 300×140 at the project's 2× scale.
      // The label sits in a margin the canvas grows to the right, so it is wider than
      // the source and exactly as tall.
      expect(result.size.height).toBe(140)
      expect(result.size.width).toBeGreaterThan(300)
      expect(pngSize(result.file).width).toBe(result.size.width * 2)
    },
  )

  it('refuses a mark that queries the page, since there is no page', async () => {
    const { loaded, library } = project()
    const recipe = {
      ...library.recipes.get('annotated')!,
      marks: { due: { css: '.card' } },
    }
    await expect(shoot(recipe, library, loaded)).rejects.toThrow(
      /^recipe "annotated": marks\.due — queries the page, but `source: file` has no page — give it a `rect: \[x, y, width, height\]`$/,
    )
  })

  // Both are mistakes made while writing the recipe, so both are refused before a browser
  // is needed at all. `unusable` fails the test if one is reached: without it, "reported
  // early" is a claim no assertion here would notice being broken.
  const unusable = {
    newContext: () => Promise.reject(new Error('a browser was used')),
    close: () => Promise.resolve(),
  }

  it('says where it looked for a file that is not there', async () => {
    const { loaded, library } = project()
    const recipe = { ...library.recipes.get('annotated')!, file: 'incoming/not-here.png' }
    await expect(shoot(recipe, library, loaded, { browser: unusable })).rejects.toThrow(
      /^recipe "annotated": `file:` — no file at .*incoming\/not-here\.png — a relative path is resolved from the config file's directory$/,
    )
  })

  it('says a file that is not an image is not one, rather than failing on its header', async () => {
    const { loaded, library } = project()
    const recipe = { ...library.recipes.get('annotated')!, file: 'shotlist.config.yaml' }
    await expect(shoot(recipe, library, loaded, { browser: unusable })).rejects.toThrow(
      /^recipe "annotated": `file:` — shotlist\.config\.yaml is not a PNG, JPEG or WebP — /,
    )
  })
})

describe('style in a real browser', () => {
  /** Shoot `annotated` with a style override, and report the canvas and any warnings. */
  async function withStyle(style: Record<string, unknown>) {
    const { loaded, library } = project()
    const recipe = { ...library.recipes.get('annotated')!, style }
    return shoot(recipe, library, loaded)
  }

  it(
    'lays a serif out differently from a sans, because it measures the real font',
    { timeout: 120_000 },
    async () => {
      // Generic families, not Arial and Georgia: those are Microsoft's, absent from a
      // stock Linux runner, and the test would measure two fallbacks against each other
      // and warn about both.
      const sans = await withStyle({ label: { font: 'sans-serif' } })
      const serif = await withStyle({ label: { font: 'serif' } })
      // The label sits in a margin sized to its width, so a wider face makes a wider shot.
      expect(serif.size.width).not.toBe(sans.size.width)
      expect(sans.warnings).toBeUndefined()
      expect(serif.warnings).toBeUndefined()
    },
  )

  it(
    'warns when the font named is not installed, rather than silently using another',
    { timeout: 120_000 },
    async () => {
      const result = await withStyle({
        label: { font: '"Absolutely Not Installed", "Also Not Installed", serif' },
      })
      expect(result.warnings?.[0]).toMatch(/none of them is available/)
      // It still produced an image: a fallback is worth saying, not worth failing over.
      expect(existsSync(result.file)).toBe(true)
    },
  )

  it('draws on a light canvas as readily as a dark one', { timeout: 120_000 }, async () => {
    const light = await withStyle({ canvas: '#FFFFFF', color: '#B91C1C' })
    expect(existsSync(light.file)).toBe(true)
    expect(light.size.width).toBeGreaterThan(300)
  })

  it('shoots at a scale other than two', { timeout: 120_000 }, async () => {
    const { loaded, library } = project()
    const recipe = { ...library.recipes.get('annotated')!, scale: 1 }
    const result = await shoot(recipe, library, loaded)
    // The source is 600×280 image pixels, which at 1x is 600×280 CSS pixels.
    expect(result.size.height).toBe(280)
    expect(pngSize(result.file).width).toBe(result.size.width)
  })
})

describe('arrow placement in a real browser', () => {
  // jsdom has no canvas, so the metric-box fallback is all a unit test can reach. The
  // path that measures real glyph ink only runs in a browser, and it is the one that has
  // been wrong: a label's arrow left from inside its first line rather than between them.
  it('leaves a two-line label from between its lines', { timeout: 120_000 }, async () => {
    const browser = await loadPlaywright().chromium.launch()
    try {
      const context = await browser.newContext({
        viewport: { width: 460, height: 320 },
        deviceScaleFactor: 2,
      })
      const page = await context.newPage()
      await page.setContent('<style>html,body{margin:0}</style><img id="shotlist-image">')
      const style = parseConfig({ site: { url: 'http://x' } }).style
      await page.evaluate(drawAnnotations, {
        image: { width: 460, height: 320 },
        scale: 2,
        style: { ...style, label: { ...style.label, stroke: style.color } } as never,
        marks: [
          {
            rect: { x: 20, y: 140, width: 30, height: 30 },
            text: ['Drag to move', 'a combatant'],
            place: 'right' as const,
            badge: 'tl' as const,
            box: true,
            inside: true,
            gap: 260,
          },
        ],
      })

      const measured = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('#shotlist-layer text')]
        const context = document.createElement('canvas').getContext('2d')!
        const first = texts[0] as SVGTextElement
        context.font = window.getComputedStyle(first).font
        const inkOf = (node: Element) => {
          const anchor = Number(node.getAttribute('y'))
          const box = (node as SVGTextElement).getBBox()
          return { top: box.y, bottom: box.y + box.height, anchor }
        }
        const points = document
          .querySelector('#shotlist-layer polygon')!
          .getAttribute('points')!
          .split(' ')
          .map((pair) => Number(pair.split(',')[1]))
        return {
          lineOne: inkOf(texts[0]!),
          lineTwo: inkOf(texts[1]!),
          // The tail is the widest part of the shaft, furthest from the tip.
          tail: Math.max(...points) - (Math.max(...points) - Math.min(...points)) / 2,
        }
      }, undefined)

      // In the gap between the two lines — a band a few pixels wide, not merely
      // somewhere within the block. Measuring a label against a different baseline from
      // the one it is drawn with put the tail most of a line above this.
      // The metric boxes very nearly touch, so a couple of pixels of slack — still a
      // far narrower band than the fault this pins, which was most of a line.
      const slack = 2
      expect(measured.tail).toBeGreaterThanOrEqual(measured.lineOne.bottom - slack)
      expect(measured.tail).toBeLessThanOrEqual(measured.lineTwo.top + slack)
    } finally {
      await browser.close()
    }
  })
})

// A local stylesheet cannot be linked: the drawing page is built with `setContent`, so it
// has no file origin and a browser refuses it a `file:` subresource — silently, which is
// worse than refusing it loudly. It is read and inlined instead, fonts and all.
describe('a font the project ships itself', () => {
  const FONT = join(dirname(fileURLToPath(import.meta.url)), 'fixture/JetBrainsMono-Bold.woff2')

  const SHEET = `@font-face {
    font-family: 'Shotlist Mono';
    src: url('JetBrainsMono-Bold.woff2') format('woff2');
    font-weight: 700;
  }`

  /**
   * A project whose labels are set in a font it ships.
   *
   * The family is named with no fallback on purpose. A stack that ends in Arial resolves
   * whatever happens to the webfont, and the warning — the only signal here that the font
   * arrived — would stay silent either way.
   */
  function withFont(css: string, fontUrl: string) {
    const { loaded, library } = project()
    mkdirSync(join(loaded.root, 'fonts'), { recursive: true })
    writeFileSync(join(loaded.root, 'fonts/mono.css'), css)
    copyFileSync(FONT, join(loaded.root, 'fonts/JetBrainsMono-Bold.woff2'))
    loaded.config.style.label.font = 'Shotlist Mono'
    loaded.config.style.label.fontUrl = fontUrl
    return { loaded, library }
  }

  const shootIt = (loaded: LoadedConfig, library: ReturnType<typeof loadLibrary>) =>
    shoot(library.recipes.get('order-row')!, library, loaded)

  it('is silent about a font that arrived, and says so when one did not', async () => {
    // Both halves, because either alone passes for the wrong reason: a stylesheet that
    // loads nothing is the control that proves the silence means something.
    const arrived = withFont(SHEET, 'fonts/mono.css')
    expect((await shootIt(arrived.loaded, arrived.library)).warnings ?? []).toEqual([])

    const missing = withFont('/* defines no family */', 'fonts/mono.css')
    expect((await shootIt(missing.loaded, missing.library)).warnings?.[0]).toMatch(
      /names Shotlist Mono, and none of them is available/,
    )
  }, 120_000)

  it('loads one named by an absolute file: URL', { timeout: 120_000 }, async () => {
    const { loaded, library } = withFont(SHEET, 'x')
    loaded.config.style.label.fontUrl = pathToFileURL(join(loaded.root, 'fonts/mono.css')).href
    expect((await shootIt(loaded, library)).warnings ?? []).toEqual([])
  })

  it('says where it looked for a stylesheet that is not there', async () => {
    const { loaded, library } = withFont(SHEET, 'fonts/missing.css')
    await expect(shootIt(loaded, library)).rejects.toThrow(
      /style\.label\.fontUrl: no stylesheet at .*fonts\/missing\.css/,
    )
  }, 120_000)

  it('treats a value that is markup as the path it is not, rather than as markup', async () => {
    // It used to be interpolated into a `<link href>`, where a quote closed the attribute
    // and opened a script tag — in the page holding the screenshot.
    const { loaded, library } = withFont(SHEET, '"><script>globalThis.PWNED=1</script>')
    await expect(shootIt(loaded, library)).rejects.toThrow(/no stylesheet at /)
  }, 120_000)

  it('says which font a stylesheet points at when that is missing', async () => {
    const { loaded, library } = withFont(
      "@font-face { font-family: 'X'; src: url('gone.woff2'); }",
      'fonts/mono.css',
    )
    await expect(shootIt(loaded, library)).rejects.toThrow(
      /mono\.css points at gone\.woff2, and there is no file there/,
    )
  }, 120_000)
})
