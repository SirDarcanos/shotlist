import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_PIXELS, ShotlistError, fromRoot, mergeStyle, pageMessage } from './config.js'
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
  /**
   * Regions `check.ignore` asked not to be compared, in the written image's own pixels.
   * Resolved on this shot, so a check blanks where the box is now — a box that moved is
   * still a difference.
   */
  ignored?: Rect[]
  /** Things worth saying that did not stop the shot — a font that fell back, so far. */
  warnings?: string[]
}

/** An attempt that failed and is about to be made again. */
export interface Retry {
  name: string
  /** Which attempt failed, counting from 1. */
  attempt: number
  /** How many will be made in all. */
  of: number
  why: string
}

/**
 * A failure during a shot, addressed by the key in the recipe that caused it.
 *
 * A project shoots many recipes in one run, and a query resolves against a page rather
 * than against the document being validated — so without this the author is told what
 * went wrong and not where they wrote it.
 */
function inRecipe(recipe: Recipe, path: string, cause: string): ShotlistError {
  return new ShotlistError(`recipe "${recipe.name}": ${path} — ${cause}`)
}

/** The viewport, scale and theme this recipe runs at: the site's, with its own on top. */
function settingsFor(recipe: Recipe, config: Config) {
  const settings = {
    url: recipe.url ?? config.site.url,
    viewport: recipe.viewport ?? config.site.viewport,
    scale: recipe.scale ?? config.site.scale,
    theme: recipe.theme ?? config.site.theme,
  }
  // Each is in range on its own; it is the product the browser has to paint, and past
  // what it can the tab dies with a protocol error rather than anything to act on.
  for (const side of ['width', 'height'] as const) {
    const pixels = settings.viewport[side] * settings.scale
    if (pixels > MAX_PIXELS) {
      throw inRecipe(
        recipe,
        `viewport.${side} × scale`,
        `is ${pixels} device pixels, and a browser cannot paint past ${MAX_PIXELS}`,
      )
    }
  }
  return settings
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
      ...(callout.inside !== undefined ? { inside: callout.inside } : {}),
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
  masks: Rect[],
): Promise<{
  png: Buffer
  size: { width: number; height: number }
  margin: { left: number; top: number }
  warnings: string[]
}> {
  const context = await browser.newContext({
    viewport: { width: Math.ceil(size.width), height: Math.ceil(size.height) },
    deviceScaleFactor: scale,
  })
  try {
    const page = await context.newPage()
    // Escaped even though the schema holds it to a URL: this is markup, and the two
    // checks fail independently.
    const href = style.label.fontUrl?.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    const sheet = href ? `<link rel="stylesheet" href="${href}">` : ''
    await page.setContent(
      sheet +
        `<style>html,body{margin:0}img{display:block}</style>` +
        `<img id="shotlist-image" src="data:image/png;base64,${image.toString('base64')}">`,
    )
    // A webfont arrives after the document does; measuring before it lands would size
    // every label against the fallback.
    if (style.label.fontUrl) {
      await page.evaluate(() => document.fonts.ready.then(() => undefined), undefined)
    }
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
      masks,
    })
    await page.setViewportSize({
      width: Math.ceil(canvas.width),
      height: Math.ceil(canvas.height),
    })
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      animations: 'disabled',
    })
    return {
      png,
      size: { width: canvas.width, height: canvas.height },
      margin: canvas.margin,
      warnings: canvas.fontWarning ? [canvas.fontWarning] : [],
    }
  } finally {
    await context.close()
  }
}

/** The pixel size in a PNG's header, or null for anything that is not one. */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * Read the image a `source: file` recipe annotates, before a browser is launched.
 *
 * A path typo and a JPEG are both mistakes a person makes while writing the recipe, and
 * neither should cost the second it takes to start Chromium before being reported.
 */
function sourceImage(
  recipe: Recipe,
  loaded: LoadedConfig,
): { image: Buffer; pixels: { width: number; height: number } } {
  const path = fromRoot(loaded, recipe.file!)
  if (!existsSync(path)) {
    throw inRecipe(
      recipe,
      '`file:`',
      `no file at ${path} — a relative path is resolved from the config file's directory`,
    )
  }
  const image = readFileSync(path)
  const pixels = pngSize(image)
  if (!pixels) {
    throw inRecipe(
      recipe,
      '`file:`',
      `${recipe.file} is not a PNG — the image size is read from a PNG header, so convert it first`,
    )
  }
  return { image, pixels }
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
  options: { install?: boolean; browser?: Browser; onRetry?: (retry: Retry) => void } = {},
): Promise<ShotResult> {
  const { config } = loaded
  const style = mergeStyle(config.style, recipe.style as never)
  const settings = settingsFor(recipe, config)
  const outDir = fromRoot(loaded, config.paths.out)
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${recipe.name}.png`)
  const source = recipe.source === 'file' ? sourceImage(recipe, loaded) : undefined

  // A caller shooting a whole set passes its own browser: launching one per recipe costs
  // about a second each, which over a project's worth of recipes is most of the run.
  const browser = options.browser ?? (await loadPlaywright().chromium.launch())
  const ours = options.browser === undefined

  /** One attempt at the whole shot: a fresh context, through to the written file. */
  const attempt = async (): Promise<ShotResult> => {
    let image: Buffer
    let size: { width: number; height: number }
    let marks: Mark[]
    let masks: Rect[]
    let ignore: Rect[] = []

    if (source) {
      image = source.image
      const pixels = source.pixels
      size = { width: pixels.width / settings.scale, height: pixels.height / settings.scale }
      const rects: Record<string, Rect> = {}
      for (const [name, query] of Object.entries(recipe.marks)) {
        if (!('rect' in (query as object))) {
          throw inRecipe(
            recipe,
            `marks.${name}`,
            'queries the page, but `source: file` has no page — give it a `rect: [x, y, width, height]`',
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
      masks = recipe.mask.map((query, i) => {
        if (!('rect' in (query as object))) {
          throw inRecipe(
            recipe,
            `mask[${i}]`,
            'queries the page, but `source: file` has no page — give it a `rect: [x, y, width, height]`',
          )
        }
        const [x, y, width, height] = (query as { rect: [number, number, number, number] }).rect
        return {
          x: x / settings.scale,
          y: y / settings.scale,
          width: width / settings.scale,
          height: height / settings.scale,
        }
      })
    } else {
      const context = await browser.newContext({
        viewport: settings.viewport,
        deviceScaleFactor: settings.scale,
        colorScheme: settings.theme,
        reducedMotion: config.site.reducedMotion ? 'reduce' : 'no-preference',
      })
      try {
        const page = await context.newPage()
        // The site not being up is the first thing a new project gets wrong, and
        // `net::ERR_CONNECTION_REFUSED` on its own does not say which key to look at.
        try {
          await page.goto(settings.url, { waitUntil: 'load' })
        } catch (error) {
          throw inRecipe(
            recipe,
            recipe.url ? '`url`' : '`site.url`',
            `could not open ${settings.url} — ${pageMessage(error)}. Is the site running?`,
          )
        }
        if (config.site.ready) {
          try {
            await page.waitForSelector(config.site.ready, { timeout: config.site.timeout })
          } catch {
            throw inRecipe(
              recipe,
              '`site.ready`',
              `waited ${config.site.timeout}ms at ${settings.url} for "${config.site.ready}", which never appeared`,
            )
          }
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
        try {
          await runSteps(expandSteps(recipe.setup, library.macros), ctx)
        } catch (error) {
          throw inRecipe(recipe, 'setup', pageMessage(error))
        }

        let clip: Rect
        try {
          clip = await clipRect(recipe.clip, ctx, settings.viewport)
        } catch (error) {
          throw inRecipe(recipe, 'clip', pageMessage(error))
        }
        ctx.rects['clip'] = clip
        for (const [name, query] of Object.entries(recipe.marks)) {
          try {
            ctx.rects[name] = (await resolveInPage(ctx.page, query, ctx)).rect
          } catch (error) {
            throw inRecipe(recipe, `marks.${name}`, pageMessage(error))
          }
        }

        masks = []
        for (const [i, query] of recipe.mask.entries()) {
          try {
            const { rect } = await resolveInPage(ctx.page, query, ctx)
            masks.push({ ...rect, x: rect.x - clip.x, y: rect.y - clip.y })
          } catch (error) {
            throw inRecipe(recipe, `mask[${i}]`, pageMessage(error))
          }
        }

        const skip = recipe.check === false ? [] : (recipe.check?.ignore ?? [])
        for (const [i, query] of skip.entries()) {
          try {
            const { rect } = await resolveInPage(ctx.page, query, ctx)
            ignore.push({ ...rect, x: rect.x - clip.x, y: rect.y - clip.y })
          } catch (error) {
            throw inRecipe(recipe, `check.ignore[${i}]`, pageMessage(error))
          }
        }

        image = await ctx.page.screenshot({ clip, animations: 'disabled' })
        size = { width: clip.width, height: clip.height }
        marks = marksFor(recipe, ctx.rects, clip)
      } finally {
        await context.close()
      }
    }

    // A mask is drawn in the same pass as the callouts, so a shot with nothing to point
    // out but something to hide still goes through it.
    const drawn =
      marks.length || masks.length
        ? await annotate(browser, image, size, settings.scale, style, marks, masks)
        : {
            png: image,
            size: { width: size.width, height: size.height },
            margin: { left: 0, top: 0 },
            warnings: [],
          }

    // Image pixels: the rect is measured against the clip, the canvas may have grown
    // around it for labels, and the picture is written at `scale` device pixels each.
    const ignored = ignore.map((rect) => ({
      x: (rect.x + drawn.margin.left) * settings.scale,
      y: (rect.y + drawn.margin.top) * settings.scale,
      width: rect.width * settings.scale,
      height: rect.height * settings.scale,
    }))

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
      ...(ignored.length ? { ignored } : {}),
      ...(drawn.warnings.length ? { warnings: drawn.warnings } : {}),
    }
  }

  try {
    // `source: file` has no page to be flaky about: its failures are in the recipe
    // itself, and shooting it again would only report them again, more slowly.
    const attempts = source ? 1 : 1 + recipe.retries
    for (let n = 1; ; n++) {
      try {
        return await attempt()
      } catch (error) {
        if (n >= attempts) throw error
        const why = error instanceof ShotlistError ? error.message : pageMessage(error)
        options.onRetry?.({ name: recipe.name!, attempt: n, of: attempts, why })
      }
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
