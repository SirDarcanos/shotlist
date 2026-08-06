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
