import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromRoot } from './config.js'
import type { LoadedConfig } from './config.js'
import { shoot } from './capture.js'
import type { Retry } from './capture.js'
import { loadPlaywright } from './playwright.js'
import type { Browser } from './playwright.js'
import type { Library, Recipe } from './recipe.js'

export interface CheckResult {
  name: string
  /** `same` and `changed` compare against the committed image; the rest could not. */
  status: 'same' | 'changed' | 'new' | 'skipped' | 'failed'
  /** The fraction of pixels that differ, when there was something to compare. */
  ratio?: number
  reason?: string
  shot?: string
  against?: string
  /** Where the three-up was written, when `--diff` asked for one. */
  diff?: string
}

/**
 * How a diff image is painted.
 *
 * Not config: a diff is shotlist's own diagnostic, looked at once and thrown away, not
 * an image the project ships. The style keys exist for what a project publishes.
 */
const DIFF = { gap: 12, background: '#0D1117', highlight: '#FF2D55' }

/**
 * Render baseline, current, and the changed pixels, side by side, in the page.
 *
 * Serialized into the browser like `comparePixels`, so it closes over nothing — the two
 * repeat a few lines of image loading between them for that reason. Only a shot that
 * actually changed pays for this second pass.
 */
async function renderDiff(input: {
  before: string
  after: string
  tolerance: number
  gap: number
  background: string
  highlight: string
}): Promise<string> {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((done, fail) => {
      const img = new Image()
      img.addEventListener('load', () => done(img), { once: true })
      img.addEventListener('error', () => fail(new Error('could not decode image')), { once: true })
      img.src = src
    })

  const draw = (img: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    return canvas
  }

  const [before, after] = await Promise.all([load(input.before), load(input.after)])
  const panels = [draw(before), draw(after)]

  // A pixel overlay needs the two to line up. When they do not, the size change is the
  // whole story and the two panels tell it.
  if (before.naturalWidth === after.naturalWidth && before.naturalHeight === after.naturalHeight) {
    const overlay = draw(after)
    const context = overlay.getContext('2d')!
    const a = draw(before).getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height)
    const b = context.getImageData(0, 0, overlay.width, overlay.height)
    const tint = context.createImageData(overlay.width, overlay.height)
    for (let i = 0; i < a.data.length; i += 4) {
      const moved =
        Math.max(
          Math.abs(a.data[i]! - b.data[i]!),
          Math.abs(a.data[i + 1]! - b.data[i + 1]!),
          Math.abs(a.data[i + 2]! - b.data[i + 2]!),
          Math.abs(a.data[i + 3]! - b.data[i + 3]!),
        ) > input.tolerance
      if (!moved) continue
      tint.data[i] = parseInt(input.highlight.slice(1, 3), 16)
      tint.data[i + 1] = parseInt(input.highlight.slice(3, 5), 16)
      tint.data[i + 2] = parseInt(input.highlight.slice(5, 7), 16)
      tint.data[i + 3] = 255
    }
    const patch = document.createElement('canvas')
    patch.width = overlay.width
    patch.height = overlay.height
    patch.getContext('2d')!.putImageData(tint, 0, 0)
    context.drawImage(patch, 0, 0)
    panels.push(overlay)
  }

  const height = Math.max(...panels.map((panel) => panel.height))
  const width =
    panels.reduce((total, panel) => total + panel.width, 0) + input.gap * (panels.length - 1)
  const sheet = document.createElement('canvas')
  sheet.width = width
  sheet.height = height
  const context = sheet.getContext('2d')!
  context.fillStyle = input.background
  context.fillRect(0, 0, width, height)
  let x = 0
  for (const panel of panels) {
    context.drawImage(panel, x, 0)
    x += panel.width + input.gap
  }
  return sheet.toDataURL('image/png')
}

/** Count the pixels that differ between two images, in the page. */
async function comparePixels(input: {
  before: string
  after: string
  tolerance: number
}): Promise<{ differing: number; total: number; sizes: [string, string] }> {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((done, fail) => {
      const img = new Image()
      img.addEventListener('load', () => done(img), { once: true })
      img.addEventListener('error', () => fail(new Error('could not decode image')), { once: true })
      img.src = src
    })

  const pixels = (img: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(img, 0, 0)
    return context.getImageData(0, 0, canvas.width, canvas.height)
  }

  const [before, after] = await Promise.all([load(input.before), load(input.after)])
  const sizes: [string, string] = [
    `${before.naturalWidth}×${before.naturalHeight}`,
    `${after.naturalWidth}×${after.naturalHeight}`,
  ]
  // Two images of different sizes have no per-pixel answer; -1 says so.
  if (before.naturalWidth !== after.naturalWidth || before.naturalHeight !== after.naturalHeight) {
    return { differing: -1, total: 0, sizes }
  }

  const a = pixels(before)
  const b = pixels(after)
  let differing = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i]! - b.data[i]!)
    const dg = Math.abs(a.data[i + 1]! - b.data[i + 1]!)
    const db = Math.abs(a.data[i + 2]! - b.data[i + 2]!)
    const da = Math.abs(a.data[i + 3]! - b.data[i + 3]!)
    if (Math.max(dr, dg, db, da) > input.tolerance) differing++
  }
  return { differing, total: a.data.length / 4, sizes }
}

/** Where a recipe's committed image lives, if it installs anywhere. */
function committedFile(recipe: Recipe, loaded: LoadedConfig): string | undefined {
  if (!recipe.install || recipe.install === 'none') return undefined
  const target = loaded.config.install[recipe.install]
  return target ? `${fromRoot(loaded, target)}/${recipe.name}.png` : undefined
}

/**
 * Re-shoot recipes and compare each against the image the project committed.
 *
 * The comparison runs in the browser that took the shot, so no image library is needed
 * for something the tool already has a decoder for.
 */
export async function check(
  recipes: readonly Recipe[],
  library: Library,
  loaded: LoadedConfig,
  options: {
    browser?: Browser
    keepGoing?: boolean
    onRetry?: (retry: Retry) => void
    /** Where to write a three-up for each shot that changed. */
    diffDir?: string
  } = {},
): Promise<CheckResult[]> {
  // A caller that already has one passes it, the same way `shoot` takes one — the CLI
  // reads the browser's version off it before any recipe is re-shot.
  const browser: Browser = options.browser ?? (await loadPlaywright().chromium.launch())
  const ours = options.browser === undefined
  const results: CheckResult[] = []
  try {
    const page = await (await browser.newContext()).newPage()
    await page.setContent('<body></body>')

    for (const recipe of recipes) {
      if (recipe.check === false) {
        results.push({
          name: recipe.name!,
          status: 'skipped',
          reason: 'the recipe opts out of checking',
        })
        continue
      }
      // The project's limits, with whatever this recipe says on top.
      const limits = { ...loaded.config.check, ...(recipe.check || {}) }
      const against = committedFile(recipe, loaded)
      if (!against) {
        results.push({
          name: recipe.name!,
          status: 'skipped',
          reason: 'installs nowhere, so there is nothing to compare against',
        })
        continue
      }
      // A shot that cannot be taken is not drift, and with `--keep-going` it is also not
      // a reason to stop: the other recipes still have an answer worth reporting.
      let shotResult
      try {
        shotResult = await shoot(recipe, library, loaded, { browser, onRetry: options.onRetry })
      } catch (error) {
        if (!options.keepGoing) throw error
        results.push({
          name: recipe.name!,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (!existsSync(against)) {
        results.push({ name: recipe.name!, status: 'new', shot: shotResult.file, against })
        continue
      }
      const uri = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`
      const compared = await page.evaluate(comparePixels, {
        before: uri(against),
        after: uri(shotResult.file),
        tolerance: limits.tolerance,
      })
      /** The three-up for a shot that moved, written where `--diff` asked for it. */
      const drawDiff = async (): Promise<string | undefined> => {
        if (!options.diffDir) return undefined
        const url = await page.evaluate(renderDiff, {
          before: uri(against),
          after: uri(shotResult.file),
          tolerance: limits.tolerance,
          ...DIFF,
        })
        mkdirSync(options.diffDir, { recursive: true })
        const file = join(options.diffDir, `${recipe.name}.png`)
        writeFileSync(file, Buffer.from(url.split(',')[1]!, 'base64'))
        return file
      }

      if (compared.differing < 0) {
        results.push({
          name: recipe.name!,
          status: 'changed',
          reason: `size changed, ${compared.sizes[0]} to ${compared.sizes[1]}`,
          shot: shotResult.file,
          against,
          diff: await drawDiff(),
        })
        continue
      }
      const ratio = compared.total ? compared.differing / compared.total : 0
      const changed = ratio > limits.threshold
      results.push({
        name: recipe.name!,
        status: changed ? 'changed' : 'same',
        ratio,
        shot: shotResult.file,
        against,
        ...(changed ? { diff: await drawDiff() } : {}),
      })
    }
  } finally {
    if (ours) await browser.close()
  }
  return results
}
