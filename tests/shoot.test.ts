import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadLibrary, parseConfig, readDocument, shoot, withNumbering } from '../src/index.js'
import type { LoadedConfig } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, 'project')
const FIXTURE = pathToFileURL(join(HERE, 'fixture/index.html')).href

/** The fixture project, pointed at the fixture page on disk. */
function project(): { loaded: LoadedConfig; library: ReturnType<typeof loadLibrary> } {
  const raw = readDocument(join(ROOT, 'shotlist.config.yaml')) as Record<string, unknown>
  const site = raw['site'] as Record<string, unknown>
  site['url'] = FIXTURE
  const config = parseConfig(raw)
  const loaded: LoadedConfig = { config, root: ROOT, file: join(ROOT, 'shotlist.config.yaml') }
  const library = loadLibrary({
    recipes: join(ROOT, config.paths.recipes),
    macros: join(ROOT, config.paths.macros),
    data: join(ROOT, config.paths.data),
    finders: config.finders,
  })
  return { loaded, library }
}

/** A PNG's pixel size, read from its header. */
function pngSize(file: string): { width: number; height: number } {
  const png = readFileSync(file)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

afterAll(() => {
  rmSync(join(ROOT, 'out'), { recursive: true, force: true })
  rmSync(join(ROOT, 'installed'), { recursive: true, force: true })
})

describe('shoot', () => {
  it(
    'drives the page, clips a region, draws the callouts and installs the image',
    async () => {
      const { loaded, library } = project()
      const recipe = withNumbering(library.recipes.get('order-row')!)
      const result = await shoot(recipe, library, loaded, { install: true })

      expect(existsSync(result.file)).toBe(true)
      expect(result.installed).toBe(join(ROOT, 'installed', 'order-row.png'))
      expect(existsSync(result.installed!)).toBe(true)

      // The canvas is wider than the clip because a label sits in a margin on each side.
      const clipWidth = 400 + 12 * 2
      expect(result.size.width).toBeGreaterThan(clipWidth)
      const pixels = pngSize(result.file)
      expect(pixels.width).toBe(result.size.width * 2)
    },
    { timeout: 120_000 },
  )

  it(
    'numbers marks in the order the recipe lists them',
    async () => {
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
    },
    { timeout: 120_000 },
  )

  it('refuses an install destination the config never named', async () => {
    const { loaded, library } = project()
    const recipe = { ...library.recipes.get('modal')!, install: 'nowhere' }
    await expect(shoot(recipe, library, loaded, { install: true })).rejects.toThrow(
      /installs to "nowhere".*it defines guide/s,
    )
  })
})
