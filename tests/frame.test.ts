import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadPlaywright, runSteps } from '../src/index.js'
import type { Browser, Page } from '../src/playwright.js'
import { resolve } from '../src/steps.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Serve the fixtures. Two of these run, so a frame can be loaded from another origin. */
function serve(): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((ready) => {
    const server: Server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? '/', 'http://localhost')
      try {
        response.end(readFileSync(join(HERE, 'fixture', pathname.replace(/^\/+/, ''))))
      } catch {
        response.statusCode = 404
        response.end('not found')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      ready({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

let browser: Browser
let page: Page
let here: Awaited<ReturnType<typeof serve>>
let elsewhere: Awaited<ReturnType<typeof serve>>

beforeAll(async () => {
  ;[here, elsewhere] = await Promise.all([serve(), serve()])
  browser = await loadPlaywright().chromium.launch()
  page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await here?.close()
  await elsewhere?.close()
})

const ctx = { rects: {}, viewport: { width: 900, height: 600 }, timeout: 5000 }

/**
 * Where the element really is, according to Playwright rather than to arithmetic here.
 *
 * `boundingBox` is reported against the main frame whatever document the element is in,
 * so it is an oracle the translation under test does not share a code path with. The
 * fixture puts the div at (20, 30) inside the frame, so an untranslated rect is that.
 */
const UNTRANSLATED = { x: 20, y: 30 }

describe('a query naming a frame', () => {
  it('finds an element inside a same-origin iframe, in page coordinates', async () => {
    await page.goto(`${here.origin}/framed.html`, { waitUntil: 'load' })
    const found = await resolve(page, { frame: { css: 'iframe#panel' }, css: '#total' }, ctx)
    expect(found.element).not.toBeNull()
    const truth = await found.element!.boundingBox()
    expect(Math.round(found.rect.x)).toBe(Math.round(truth!.x))
    expect(Math.round(found.rect.y)).toBe(Math.round(truth!.y))
    expect(Math.round(found.rect.width)).toBe(120)
    // The frame sits well down and along the page, so an untranslated rect is a
    // different number rather than the same one arrived at by luck.
    expect(Math.round(found.rect.x)).not.toBe(UNTRANSLATED.x)
    expect(Math.round(found.rect.y)).not.toBe(UNTRANSLATED.y)
  })

  it('does the same across origins, where the top document cannot read in at all', async () => {
    await page.goto(`${here.origin}/framed.html?src=${elsewhere.origin}/framed-inner.html`, {
      waitUntil: 'load',
    })
    // Proof the frame really is another origin, which is the whole point of this test:
    // a cross-origin `contentDocument` is null, so the page cannot read in at all.
    const reachable = await page.evaluate(() => {
      const frame = document.querySelector('iframe') as HTMLIFrameElement
      try {
        return frame.contentDocument !== null
      } catch {
        return false
      }
    }, undefined)
    expect(reachable).toBe(false)

    const found = await resolve(page, { frame: { css: 'iframe#panel' }, css: '#total' }, ctx)
    expect(found.element).not.toBeNull()
    const truth = await found.element!.boundingBox()
    expect(Math.round(found.rect.x)).toBe(Math.round(truth!.x))
    expect(Math.round(found.rect.y)).toBe(Math.round(truth!.y))
  })

  it('composes with the filters, which run inside the frame', async () => {
    await page.goto(`${here.origin}/framed.html`, { waitUntil: 'load' })
    const found = await resolve(
      page,
      { frame: { css: 'iframe#panel' }, css: 'div', contains: '$42.00' },
      ctx,
    )
    const truth = await found.element!.boundingBox()
    expect(Math.round(found.rect.x)).toBe(Math.round(truth!.x))
  })

  it('drives a step inside the frame, since a step takes the same query', async () => {
    await page.goto(`${here.origin}/framed.html`, { waitUntil: 'load' })
    const run = {
      pages: new Map<string, Page>([['main', page]]),
      page,
      vars: {},
      rects: {},
      viewport: ctx.viewport,
      timeout: 5000,
      newPage: () => Promise.reject(new Error('not needed')),
    }
    const step = { click: { frame: { css: 'iframe#panel' }, css: '#pay' } }
    await runSteps([{ step, vars: {} }], run)
    const found = await resolve(page, { frame: { css: 'iframe#panel' }, css: '#paid' }, ctx)
    expect(found.element).not.toBeNull()
  })

  it('says so when the query names something that is not a frame', async () => {
    await page.goto(`${here.origin}/framed.html`, { waitUntil: 'load' })
    await expect(resolve(page, { frame: { css: '#outside' }, css: '#total' }, ctx)).rejects.toThrow(
      /not an iframe/,
    )
  })

  it('refuses a `within` naming a rect the inner document never saw', async () => {
    await page.goto(`${here.origin}/framed.html`, { waitUntil: 'load' })
    await expect(
      resolve(page, { frame: { css: 'iframe#panel' }, css: '#total', within: 'clip' }, ctx),
    ).rejects.toThrow(/another document/)
  })
})
