import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expandSteps, loadPlaywright, parseRecipe, runSteps } from '../src/index.js'
import type { RunContext } from '../src/index.js'
import type { Browser, BrowserContext, Page } from '../src/playwright.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERBS = pathToFileURL(join(HERE, 'fixture/verbs.html')).href
const INDEX = pathToFileURL(join(HERE, 'fixture/index.html')).href
const VIEWPORT = { width: 800, height: 600 }

let browser: Browser
let context: BrowserContext

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch()
  context = await browser.newContext({ viewport: VIEWPORT })
}, 120_000)

afterAll(async () => {
  await browser?.close()
})

/** Drive the verbs fixture through a recipe's setup, and hand back the page. */
async function run(setup: unknown[], url = VERBS) {
  const page: Page = await context.newPage()
  await page.goto(url, { waitUntil: 'load' })
  const ctx: RunContext = {
    pages: new Map<string, Page>([['main', page]]),
    page,
    vars: {},
    rects: {},
    viewport: VIEWPORT,
    timeout: 10_000,
    newPage: () => context.newPage(),
  }
  // Through the schema, so a test also proves the step it writes is one a recipe may use.
  const recipe = parseRecipe({ setup }, { name: 'steps' })
  await runSteps(expandSteps(recipe.setup, new Map()), ctx)
  return { page, ctx }
}

/** What the fixture recorded. */
const logOf = (page: Page) =>
  page.evaluate(() => document.getElementById('log')?.textContent ?? '', undefined)

describe('pointer verbs', () => {
  it('double-clicks and hovers', async () => {
    const { page } = await run([
      { dblclick: { css: '#btnDouble' } },
      { hover: { css: '#btnHover' } },
    ])
    expect(await logOf(page)).toBe('doubled hovered')
    await page.close()
  })

  it('scrolls an element into view before clicking it', async () => {
    // The button sits below 1500px of spacer, so a click without the scroll misses.
    const { page } = await run([
      { scrollIntoView: { css: '#btnDeep' } },
      { click: { css: '#btnDeep' } },
    ])
    expect(await logOf(page)).toBe('deep')
    await page.close()
  })
})

describe('form verbs', () => {
  it('checks and unchecks a box', async () => {
    const { page } = await run([{ check: { css: '#chkAgree' } }, { uncheck: { css: '#chkAgree' } }])
    expect(await logOf(page)).toBe('checked unchecked')
    await page.close()
  })

  it('selects an option by value and by visible label', async () => {
    const { page } = await run([
      { select: { css: '#selStatus' }, option: 'closed' },
      { select: { css: '#selStatus' }, optionLabel: 'Open' },
    ])
    expect(await logOf(page)).toBe('status=closed status=open')
    await page.close()
  })

  it('types, presses a key, and blurs', async () => {
    const { page } = await run([
      { type: 'hello', on: { css: '#inpTyped' } },
      { press: 'Enter', on: { css: '#inpTyped' } },
      { click: { css: '#inpPreset' } },
      { blur: { css: '#inpPreset' } },
    ])
    expect(await logOf(page)).toBe('entered blurred')
    expect(
      await page.evaluate(
        () => (document.getElementById('inpTyped') as HTMLInputElement).value,
        undefined,
      ),
    ).toBe('hello')
    await page.close()
  })

  it('reads a value into a variable that a later step can use', async () => {
    const { page, ctx } = await run([
      { readValue: { css: '#inpPreset' }, as: 'captured' },
      { fill: { css: '#inpTyped' }, value: '$captured' },
    ])
    expect(ctx.vars['captured']).toBe('already here')
    expect(
      await page.evaluate(
        () => (document.getElementById('inpTyped') as HTMLInputElement).value,
        undefined,
      ),
    ).toBe('already here')
    await page.close()
  })
})

describe('control-flow verbs', () => {
  it('swallows a failure inside optional and carries on', async () => {
    const { page } = await run([
      { optional: [{ click: { css: '#nothingHere' } }] },
      { click: { css: '#btnDeep' } },
    ])
    expect(await logOf(page)).toBe('deep')
    await page.close()
  })

  it('still fails when the same step is not optional', async () => {
    await expect(run([{ click: { css: '#nothingHere' } }])).rejects.toThrow(/no element matched/)
  })

  it('repeats a block', async () => {
    const { page } = await run([{ repeat: 3, steps: [{ dblclick: { css: '#btnDouble' } }] }])
    expect(await logOf(page)).toBe('doubled doubled doubled')
    await page.close()
  })
})

describe('navigation verbs', () => {
  it('goes to another page', async () => {
    const { page } = await run([{ goto: INDEX }, { click: { css: '.row button' } }])
    expect(
      await page.evaluate(
        () => document.getElementById('modal')?.hasAttribute('hidden'),
        undefined,
      ),
    ).toBe(false)
    await page.close()
  })

  it('opens a second page, names it, and switches back', async () => {
    const { page, ctx } = await run([
      { openPage: INDEX, as: 'other' },
      { click: { css: '.row button' } },
      { usePage: 'main' },
      { dblclick: { css: '#btnDouble' } },
    ])
    // The click landed on the second page, the double-click back on the first.
    expect(await logOf(page)).toBe('doubled')
    expect([...ctx.pages.keys()]).toContain('other')
    const other = ctx.pages.get('other')!
    expect(
      await other.evaluate(
        () => document.getElementById('modal')?.hasAttribute('hidden'),
        undefined,
      ),
    ).toBe(false)
    await other.close()
    await page.close()
  })

  it('names the page it does not know', async () => {
    await expect(run([{ usePage: 'elsewhere' }])).rejects.toThrow(
      /no page named "elsewhere".*main/s,
    )
  })
})
