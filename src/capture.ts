import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ShotlistError, fromRoot, mergeStyle } from './config.js'
import type { Config, LoadedConfig, Style } from './config.js'
import { expandSteps } from './recipe.js'
import type { Library, Recipe } from './recipe.js'
import { resolve as resolveInPage, runSteps } from './steps.js'
import type { RunContext } from './steps.js'
import { drawAnnotations } from './annotate.js'
import type { DrawStyle, Mark } from './annotate.js'
import { loadPlaywright } from './playwright.js'
import type { Browser, Page } from './playwright.js'
import type { QueryInput, Rect } from './query.js'

export interface ShotResult {
  name: string
  file: string
  installed?: string
  size: { width: number; height: number }
}

/** The viewport, scale and theme this recipe runs at: the site's, with its own on top. */
function settingsFor(recipe: Recipe, config: Config) {
  return {
    url: recipe.url ?? config.site.url,
    viewport: recipe.viewport ?? config.site.viewport,
    scale: recipe.scale ?? config.site.scale,
    theme: recipe.theme ?? config.site.theme,
  }
}

/** Where a recipe's image is installed, refusing a destination the config never named. */
function destinationFor(recipe: Recipe, loaded: LoadedConfig): string | undefined {
  if (!recipe.install || recipe.install === 'none') return undefined
  const target = loaded.config.install[recipe.install]
  if (!target) {
    const known = Object.keys(loaded.config.install)
    throw new ShotlistError(
      `recipe "${recipe.name}" installs to "${recipe.install}", which the config does not define` +
        (known.length ? ` — it defines ${known.join(', ')}` : ' — it defines no destinations'),
    )
  }
  return join(fromRoot(loaded, target), `${recipe.name}.png`)
}

/** Turn the recipe's callouts into what the drawing layer needs, once the rects are known. */
function marksFor(recipe: Recipe, rects: Record<string, Rect>, origin: Rect): Mark[] {
  return recipe.callouts.map((callout) => {
    const rect = rects[callout.mark]!
    return {
      rect: { ...rect, x: rect.x - origin.x, y: rect.y - origin.y },
      ...(callout.text !== undefined ? { text: callout.text } : {}),
      ...(callout.n !== undefined ? { n: callout.n } : {}),
      place: callout.place,
      badge: callout.badge,
      box: callout.box,
      inside: callout.inside,
      ...(callout.dx !== undefined ? { dx: callout.dx } : {}),
      ...(callout.dy !== undefined ? { dy: callout.dy } : {}),
      ...(callout.pad !== undefined ? { pad: callout.pad } : {}),
      ...(callout.gap !== undefined ? { gap: callout.gap } : {}),
    }
  })
}

/** Draw the callouts over a captured image and return the finished PNG. */
async function annotate(
  browser: Browser,
  image: Buffer,
  size: { width: number; height: number },
  scale: number,
  style: Style,
  marks: Mark[],
): Promise<{ png: Buffer; size: { width: number; height: number } }> {
  const context = await browser.newContext({
    viewport: { width: Math.ceil(size.width), height: Math.ceil(size.height) },
    deviceScaleFactor: scale,
  })
  try {
    const page = await context.newPage()
    await page.setContent(
      `<style>html,body{margin:0}img{display:block}</style>` +
        `<img id="shotlist-image" src="data:image/png;base64,${image.toString('base64')}">`,
    )
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const img = document.getElementById('shotlist-image') as HTMLImageElement | null
          if (!img || img.complete) return done()
          img.addEventListener('load', () => done(), { once: true })
          img.addEventListener('error', () => done(), { once: true })
        }),
      undefined,
    )
    const canvas = await page.evaluate(drawAnnotations, {
      image: size,
      scale,
      style: style as unknown as DrawStyle,
      marks,
    })
    await page.setViewportSize({
      width: Math.ceil(canvas.width),
      height: Math.ceil(canvas.height),
    })
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      animations: 'disabled',
    })
    return { png, size: canvas }
  } finally {
    await context.close()
  }
}

/** Read the pixel size of a PNG from its header, for a recipe annotating an existing image. */
function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new ShotlistError('not a PNG')
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * Shoot one recipe.
 *
 * `source: app` drives the site and clips it; `source: file` annotates an image that is
 * already on disk. Both end in the same drawing pass, so a hand-captured screen and a
 * scripted one carry identical callouts.
 */
export async function shoot(
  recipe: Recipe,
  library: Library,
  loaded: LoadedConfig,
  options: { install?: boolean; browser?: Browser } = {},
): Promise<ShotResult> {
  const { config } = loaded
  const style = mergeStyle(config.style, recipe.style as never)
  const settings = settingsFor(recipe, config)
  const outDir = fromRoot(loaded, config.paths.out)
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${recipe.name}.png`)

  // A caller shooting a whole set passes its own browser: launching one per recipe costs
  // about a second each, which over a project's worth of recipes is most of the run.
  const browser = options.browser ?? (await loadPlaywright().chromium.launch())
  const ours = options.browser === undefined

  try {
    let image: Buffer
    let size: { width: number; height: number }
    let marks: Mark[]

    if (recipe.source === 'file') {
      image = readFileSync(fromRoot(loaded, recipe.file!))
      const pixels = pngSize(image)
      size = { width: pixels.width / settings.scale, height: pixels.height / settings.scale }
      const rects: Record<string, Rect> = {}
      for (const [name, query] of Object.entries(recipe.marks)) {
        if (!('rect' in (query as object))) {
          throw new ShotlistError(
            `mark "${name}" queries the page, but \`source: file\` has no page — give it a \`rect: [x, y, width, height]\``,
          )
        }
        const [x, y, width, height] = (query as { rect: [number, number, number, number] }).rect
        rects[name] = {
          x: x / settings.scale,
          y: y / settings.scale,
          width: width / settings.scale,
          height: height / settings.scale,
        }
      }
      marks = marksFor(recipe, rects, { x: 0, y: 0, width: 0, height: 0 })
    } else {
      const context = await browser.newContext({
        viewport: settings.viewport,
        deviceScaleFactor: settings.scale,
        colorScheme: settings.theme,
        reducedMotion: config.site.reducedMotion ? 'reduce' : 'no-preference',
      })
      try {
        const page = await context.newPage()
        await page.goto(settings.url, { waitUntil: 'load' })
        if (config.site.ready) {
          await page.waitForSelector(config.site.ready, { timeout: config.site.timeout })
        }
        if (config.site.settle) await page.waitForTimeout(config.site.settle)

        const ctx: RunContext = {
          pages: new Map<string, Page>([['main', page]]),
          page,
          vars: { ...library.data },
          rects: {},
          viewport: settings.viewport,
          timeout: config.site.timeout,
          newPage: () => context.newPage(),
        }
        await runSteps(expandSteps(recipe.setup, library.macros), ctx)

        const clip = await clipRect(recipe.clip, ctx, settings.viewport)
        ctx.rects['clip'] = clip
        for (const [name, query] of Object.entries(recipe.marks)) {
          ctx.rects[name] = (await resolveInPage(ctx.page, query, ctx)).rect
        }

        image = await ctx.page.screenshot({ clip, animations: 'disabled' })
        size = { width: clip.width, height: clip.height }
        marks = marksFor(recipe, ctx.rects, clip)
      } finally {
        await context.close()
      }
    }

    const drawn = marks.length
      ? await annotate(browser, image, size, settings.scale, style, marks)
      : { png: image, size: { width: size.width, height: size.height } }

    writeFileSync(file, drawn.png)
    const destination = destinationFor(recipe, loaded)
    if (options.install && destination) {
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(file, destination)
    }
    return {
      name: recipe.name!,
      file,
      ...(options.install && destination ? { installed: destination } : {}),
      size: drawn.size,
    }
  } finally {
    if (ours) await browser.close()
  }
}

/** The region to capture: the whole viewport, the whole page, or whatever a query finds. */
async function clipRect(
  clip: Recipe['clip'],
  ctx: RunContext,
  viewport: { width: number; height: number },
): Promise<Rect> {
  if (clip === 'viewport') return { x: 0, y: 0, ...viewport }
  if (clip === 'full') {
    const height = await ctx.page.evaluate(() => document.documentElement.scrollHeight, undefined)
    return { x: 0, y: 0, width: viewport.width, height }
  }
  const { rect } = await resolveInPage(ctx.page, clip as QueryInput, ctx)
  // Whole pixels, and inside the viewport: a clip that runs past the edge is refused by
  // the screenshot rather than trimmed.
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  return {
    x,
    y,
    width: Math.min(Math.ceil(rect.width), viewport.width - x),
    height: Math.min(Math.ceil(rect.height), viewport.height - y),
  }
}
