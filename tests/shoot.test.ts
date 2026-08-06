import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, loadLibrary, shoot, withNumbering } from '../src/index.js'
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
      /has no page — give it a `rect: \[x, y, width, height\]`/,
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
