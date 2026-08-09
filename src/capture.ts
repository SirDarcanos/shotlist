import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_PIXELS, ShotlistError, fromRoot, mergeStyle, pageMessage } from './config.js'
import { checkPath, checkUrl } from './trust.js'
import { MEDIA, extensionOf, formatOf, isLossless, sizeOf } from './image.js'
import type { Format } from './image.js'
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
    format: recipe.format ?? config.image.format,
    quality: recipe.quality ?? config.image.quality,
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
  const destination = join(
    fromRoot(loaded, target),
    `${recipe.name}${extensionOf(recipe.format ?? loaded.config.image.format)}`,
  )
  if (loaded.trust) {
    checkPath(loaded.trust, destination, `recipe "${recipe.name}": install."${recipe.install}"`)
  }
  return destination
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

/** What a font stylesheet becomes in the page: a link to fetch, or CSS to inline. */
interface FontSheet {
  href?: string
  css?: string
}

/** The media type a font file is served as, from its extension. */
function fontType(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (ext === 'woff2') return 'font/woff2'
  if (ext === 'woff') return 'font/woff'
  if (ext === 'otf') return 'font/otf'
  if (ext === 'ttf') return 'font/ttf'
  return 'application/octet-stream'
}

/** What a font file's extension has to be called in a `format()` hint. */
const FONT_FORMAT: Record<string, string | undefined> = {
  woff2: 'woff2',
  woff: 'woff',
  otf: 'opentype',
  ttf: 'truetype',
}

/**
 * The first family in a stack that names a face rather than a category.
 *
 * `sans-serif` and its like are what the platform has, not something to declare a file
 * under, so a stack of nothing else has no name to give.
 */
function namedFamily(stack: string): string | undefined {
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|ui-[\w-]+)$/
  for (const part of stack.split(',')) {
    const family = part.trim().replace(/^['"]|['"]$/g, '')
    if (family && !generic.test(family)) return family
  }
  return undefined
}

/**
 * The stylesheet `style.label.fontUrl` names, ready to put in the drawing page.
 *
 * A remote sheet is linked and fetched. A local one cannot be: the page is built with
 * `setContent`, so it has no file origin and Chromium refuses it a `file:` subresource —
 * silently, which is worse than refusing it loudly. So a local sheet is read and inlined,
 * and the font files it points at are inlined into it, because a relative `url()` in an
 * inlined sheet would resolve against a page that is nowhere.
 */
function fontSheet(style: Style, loaded: LoadedConfig): FontSheet {
  const named = style.label.fontUrl
  if (!named) return {}

  let path = named
  try {
    const url = new URL(named)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'data:') {
      return { href: named }
    }
    if (url.protocol !== 'file:') {
      throw new ShotlistError(
        `style.label.fontUrl: ${url.protocol} is not something to load a stylesheet from`,
      )
    }
    path = fileURLToPath(url)
  } catch (error) {
    if (error instanceof ShotlistError) throw error
    // Not a URL at all, so it is a path — relative to the config, like every other path.
  }

  const file = fromRoot(loaded, path)
  if (loaded.trust) checkPath(loaded.trust, file, 'style.label.fontUrl')
  if (!existsSync(file)) {
    throw new ShotlistError(
      `style.label.fontUrl: nothing at ${file} — a relative path is resolved from the ` +
        "config file's directory",
    )
  }

  // A font file rather than a stylesheet: the common case is a project shipping one face
  // it licensed, and writing a two-line `@font-face` by hand to point at it is a step
  // that only exists to be got wrong. The family it is declared under is the first real
  // one in `style.label.font`, so the stack the labels ask for is the stack it answers.
  const format = FONT_FORMAT[extname(file).slice(1).toLowerCase()]
  if (format) {
    const family = namedFamily(style.label.font)
    if (!family) {
      throw new ShotlistError(
        `style.label.fontUrl points at a font file, so style.label.font has to name the ` +
          `family to declare it under — "${style.label.font}" is only generic keywords`,
      )
    }
    const data = readFileSync(file).toString('base64')
    return {
      css:
        `@font-face{font-family:"${family}";font-weight:${style.label.weight};` +
        `font-display:block;src:url(data:${fontType(file)};base64,${data}) format("${format}")}`,
    }
  }

  const css = readFileSync(file, 'utf8').replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (whole, _quote: string, target: string) => {
      if (/^(https?:|data:)/i.test(target)) return whole
      const asset = fromRoot({ root: dirname(file) }, target.split(/[?#]/)[0]!)
      if (loaded.trust) checkPath(loaded.trust, asset, 'style.label.fontUrl')
      if (!existsSync(asset)) {
        throw new ShotlistError(
          `style.label.fontUrl: ${basename(file)} points at ${target}, and there is no file there`,
        )
      }
      return `url(data:${fontType(asset)};base64,${readFileSync(asset).toString('base64')})`
    },
  )
  return { css }
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
  font: FontSheet,
  sourceMedia: string,
  timeout: number,
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
    let slow: string | undefined
    // Escaped even where the schema already held it to a URL: this is markup, and the
    // two checks fail independently.
    const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    const sheet = font.href
      ? `<link rel="stylesheet" href="${escape(font.href)}">`
      : font.css
        ? `<style>${font.css.replace(/<\/style/gi, '<\\/style')}</style>`
        : ''
    await page.setContent(
      sheet +
        `<style>html,body{margin:0}img{display:block}</style>` +
        `<img id="shotlist-image" src="data:${sourceMedia};base64,${image.toString('base64')}">`,
    )
    // A webfont arrives after the document does; measuring before it lands would size
    // every label against the fallback.
    // Ask for the face by name rather than waiting on `document.fonts.ready`. A webfont
    // is fetched when something uses it, and until the callouts are drawn nothing here
    // does — so `ready` resolves against an empty queue and the drawing measures a font
    // that has not arrived. The label renders correctly in the end, but the check for
    // whether the family resolved runs before it and reports a fallback that never was.
    // Bounded, because nothing else here bounds it: `page.evaluate` has no timeout of its
    // own, so a stylesheet host that accepts a connection and then says nothing would hold
    // the run open for as long as it cared to. Giving up draws the labels in whatever
    // resolved, which is the same outcome as a font that is not installed, and the probe
    // below reports it either way.
    if (font.href || font.css) {
      const wanted = `${style.label.weight} ${style.label.size}px ${style.label.font}`
      const arrived = await page.evaluate(
        ({ spec, ms }) =>
          Promise.race([
            document.fonts
              .load(spec)
              .catch(() => undefined)
              .then(() => document.fonts.ready)
              .then(() => true),
            new Promise<boolean>((done) => setTimeout(() => done(false), ms)),
          ]),
        { spec: wanted, ms: timeout },
      )
      if (!arrived) {
        slow = `style.label.fontUrl did not load within ${timeout}ms — labels are drawn in whatever the browser had`
      }
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
      warnings: [slow, canvas.fontWarning].filter((one): one is string => one !== undefined),
    }
  } finally {
    await context.close()
  }
}

/**
 * Re-encode a PNG as something else, in the browser that drew it.
 *
 * The only encoder here is a canvas, which is why the formats are the three a canvas
 * writes. It answers a request it cannot meet with a PNG rather than an error — ask it
 * for AVIF and you get a PNG under an `.avif` name — so what came back is checked.
 */
async function reEncode(
  browser: Browser,
  png: Buffer,
  format: Format,
  quality: number,
): Promise<Buffer> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.setContent('<body></body>')
    const url = await page.evaluate(
      (input) =>
        new Promise<string>((done, fail) => {
          const img = new Image()
          img.addEventListener('error', () => fail(new Error('the image could not be decoded')), {
            once: true,
          })
          img.addEventListener(
            'load',
            () => {
              const canvas = document.createElement('canvas')
              canvas.width = img.naturalWidth
              canvas.height = img.naturalHeight
              canvas.getContext('2d')!.drawImage(img, 0, 0)
              done(canvas.toDataURL(input.media, input.quality / 100))
            },
            { once: true },
          )
          img.src = input.source
        }),
      { source: `data:image/png;base64,${png.toString('base64')}`, media: MEDIA[format], quality },
    )
    if (!url.startsWith(`data:${MEDIA[format]}`)) {
      throw new ShotlistError(
        `this browser cannot write ${format}, and answered with ` +
          `${url.slice(5, url.indexOf(';'))} instead`,
      )
    }
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
  } finally {
    await context.close()
  }
}

/**
 * Read the image a `source: file` recipe annotates, before a browser is launched.
 *
 * A path typo and a file that is not an image are both mistakes a person makes while
 * writing the recipe, and neither should cost the second it takes to start Chromium
 * before being reported.
 */
function sourceImage(
  recipe: Recipe,
  loaded: LoadedConfig,
): { image: Buffer; pixels: { width: number; height: number }; format: Format } {
  const path = fromRoot(loaded, recipe.file!)
  if (loaded.trust) checkPath(loaded.trust, path, `recipe "${recipe.name}": \`file:\``)
  if (!existsSync(path)) {
    throw inRecipe(
      recipe,
      '`file:`',
      `no file at ${path} — a relative path is resolved from the config file's directory`,
    )
  }
  const image = readFileSync(path)
  // Read from the bytes rather than the name: a `capture.png` that is really a JPEG is a
  // mistake worth reporting as the one it is.
  const format = formatOf(image)
  const pixels = format && sizeOf(image, format)
  if (!format || !pixels) {
    throw inRecipe(
      recipe,
      '`file:`',
      `${recipe.file} is not a PNG, JPEG or WebP — its size is read from the header, and it ` +
        'has none of theirs',
    )
  }
  return { image, pixels, format }
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
  // A `source: file` recipe never opens the site, so it is not asked to justify a URL.
  if (loaded.trust && recipe.source === 'app') {
    checkUrl(
      loaded.trust,
      settings.url,
      `recipe "${recipe.name}": ${recipe.url ? '`url`' : '`site.url`'}`,
    )
  }
  const outDir = fromRoot(loaded, config.paths.out)
  if (loaded.trust) checkPath(loaded.trust, outDir, 'paths.out')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${recipe.name}${extensionOf(settings.format)}`)
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
          ...(loaded.trust ? { trust: loaded.trust } : {}),
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

        // Every match, not the first: a page has three avatars far more often than it
        // has one, and a mask that covered only the first would ship the other two.
        masks = []
        for (const [i, query] of recipe.mask.entries()) {
          try {
            const found = await resolveInPage(ctx.page, query, { ...ctx, all: true })
            for (const rect of found.rects ?? [found.rect]) {
              masks.push({ ...rect, x: rect.x - clip.x, y: rect.y - clip.y })
            }
          } catch (error) {
            throw inRecipe(recipe, `mask[${i}]`, pageMessage(error))
          }
        }

        const skip = recipe.check === false ? [] : (recipe.check?.ignore ?? [])
        for (const [i, query] of skip.entries()) {
          try {
            const found = await resolveInPage(ctx.page, query, { ...ctx, all: true })
            for (const rect of found.rects ?? [found.rect]) {
              ignore.push({ ...rect, x: rect.x - clip.x, y: rect.y - clip.y })
            }
          } catch (error) {
            throw inRecipe(recipe, `check.ignore[${i}]`, pageMessage(error))
          }
        }

        // A clip is measured against the viewport, and so are the marks inside it — but a
        // screenshot only reaches past the fold with `fullPage`, and then its clip is
        // measured against the page. Without this, `clip: full` quietly returned one
        // viewport: the tall half of the page was never in the picture.
        const below = clip.y + clip.height > settings.viewport.height
        const scrolled = below ? await ctx.page.evaluate(() => window.scrollY, undefined) : 0
        image = await ctx.page.screenshot({
          clip: below ? { ...clip, y: clip.y + scrolled } : clip,
          ...(below ? { fullPage: true } : {}),
          animations: 'disabled',
        })
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
        ? await annotate(
            browser,
            image,
            size,
            settings.scale,
            style,
            marks,
            masks,
            fontSheet(style, loaded),
            source ? MEDIA[source.format] : MEDIA.png,
            config.site.timeout,
          )
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

    // Everything above works in PNG, because that is what a screenshot and a canvas both
    // hand back losslessly. The format the project asked for is applied once, at the end.
    const written = isLossless(settings.format)
      ? drawn.png
      : await reEncode(browser, drawn.png, settings.format, settings.quality)

    writeFileSync(file, written)
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
  // Whole pixels, and no wider than the viewport: a fractional clip comes back a pixel
  // short, and nothing widens the page the way `fullPage` lengthens it. Height is left
  // alone — a region taller than the fold is one of the ordinary things to shoot.
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  return {
    x,
    y,
    width: Math.min(Math.ceil(rect.width), viewport.width - x),
    height: Math.ceil(rect.height),
  }
}
