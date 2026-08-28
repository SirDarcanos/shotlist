import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Macro, expandSteps, loadPlaywright, openRun, parseRecipe } from '../src/index.js'
import type { OperatorAuthority, Run } from '../src/index.js'
import { networkPolicyFor } from '../src/run.js'
import { runSteps } from '../src/steps.js'
import type { RunContext } from '../src/steps.js'
import type { Browser, BrowserContext, Page } from '../src/playwright.js'
import { removeProjects, tempProject } from './tempProject.js'

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
  removeProjects()
})

/** Open the fixture Project under explicit Operator authority. */
function fixtureRun(authority: OperatorAuthority = { untrusted: false }): Run {
  return openRun(authority, join(tempProject(), 'shotlist.config.yaml'))
}

/** Drive the verbs fixture through a recipe's setup, and hand back the page. */
async function run(
  setup: unknown[],
  url = VERBS,
  macros = new Map<string, Macro>(),
  domainRun = fixtureRun(),
) {
  const page: Page = await context.newPage()
  await page.goto(url, { waitUntil: 'load' })
  const ctx: RunContext = {
    pages: new Map<string, Page>([['main', page]]),
    page,
    vars: {},
    rects: {},
    viewport: VIEWPORT,
    timeout: 10_000,
    network: networkPolicyFor(domainRun).forOperation('Step test'),
    newPage: () => context.newPage(),
  }
  // Through the schema, so a test also proves the step it writes is one a recipe may use.
  const recipe = parseRecipe({ setup }, { name: 'steps' })
  await runSteps(domainRun, expandSteps(recipe.setup, macros), ctx)
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

  it('passes a loop variable into a macro as an argument', async () => {
    // The frames are built when the file loads, so `$item` still stands for nothing then.
    const macros = new Map([
      [
        'note',
        Macro.parse({
          defaults: { what: 'nothing' },
          steps: [{ fill: { css: '#inpTyped' }, value: '$what' }],
        }),
      ],
    ])
    const { page } = await run(
      [{ each: ['one', 'two'], as: 'item', steps: [{ use: 'note', with: { what: '$item' } }] }],
      VERBS,
      macros,
    )
    const typed = await page.evaluate(
      () => (document.getElementById('inpTyped') as HTMLInputElement).value,
      undefined,
    )
    expect(typed).toBe('two')
    await page.close()
  })

  it('repeats a block', async () => {
    const { page } = await run([{ repeat: 3, steps: [{ dblclick: { css: '#btnDouble' } }] }])
    expect(await logOf(page)).toBe('doubled doubled doubled')
    await page.close()
  })
})

describe('dialog', () => {
  it("takes the browser's own default when a recipe says nothing, which is to dismiss", async () => {
    // Not the behavior anybody wants, but it is the behavior every recipe written before
    // this verb has: a `confirm()` behind a click goes down the cancel branch in silence.
    const { page } = await run([{ click: { css: '#btnConfirm' } }])
    expect(await logOf(page)).toBe('cancelled')
    await page.close()
  })

  it('accepts the confirm a later click raises', async () => {
    const { page } = await run([{ dialog: 'accept' }, { click: { css: '#btnConfirm' } }])
    expect(await logOf(page)).toBe('confirmed')
    await page.close()
  })

  it('stands until another dialog step replaces it', async () => {
    const { page } = await run([
      { dialog: 'accept' },
      { click: { css: '#btnConfirm' } },
      { click: { css: '#btnConfirm' } },
      { dialog: 'dismiss' },
      { click: { css: '#btnConfirm' } },
    ])
    expect(await logOf(page)).toBe('confirmed confirmed cancelled')
    await page.close()
  })

  it('answers a prompt with the value, and with nothing typed when there is none', async () => {
    const { page } = await run([
      { dialog: 'accept', value: 'Ada' },
      { click: { css: '#btnPrompt' } },
      { dialog: 'accept' },
      { click: { css: '#btnPrompt' } },
      { dialog: 'dismiss' },
      { click: { css: '#btnPrompt' } },
    ])
    expect(await logOf(page)).toBe('prompt=Ada prompt= prompt=none')
    await page.close()
  })

  it('gets past an alert, which blocks the page until something answers it', async () => {
    const { page } = await run([{ dialog: 'accept' }, { click: { css: '#btnAlert' } }])
    expect(await logOf(page)).toBe('alerted')
    await page.close()
  })

  it('answers on a page opened after it was set', async () => {
    const { page, ctx } = await run([
      { dialog: 'accept' },
      { openPage: VERBS, as: 'second' },
      { click: { css: '#btnConfirm' } },
    ])
    const second = ctx.pages.get('second')!
    expect(await logOf(second)).toBe('confirmed')
    await second.close()
    await page.close()
  })

  it('refuses a value on dismiss, which types nothing anywhere', async () => {
    expect(() =>
      parseRecipe({ setup: [{ dialog: 'dismiss', value: 'Ada' }] }, { name: 'x' }),
    ).toThrow()
  })

  it('refuses a word that is neither', async () => {
    expect(() => parseRecipe({ setup: [{ dialog: 'accpet' }] }, { name: 'x' })).toThrow(
      /expected "accept"/,
    )
  })
})

describe('navigation verbs', () => {
  it('interpolates environment values from the Run snapshot', async () => {
    process.env['SHOTLIST_STEP_VALUE'] = 'at opening'
    const domainRun = fixtureRun({ untrusted: false, env: ['SHOTLIST_STEP_VALUE'] })
    process.env['SHOTLIST_STEP_VALUE'] = 'after opening'
    try {
      const { page } = await run(
        [{ fill: { css: '#inpTyped' }, value: '${env.SHOTLIST_STEP_VALUE}' }],
        VERBS,
        new Map(),
        domainRun,
      )
      expect(
        await page.evaluate(
          () => (document.getElementById('inpTyped') as HTMLInputElement).value,
          undefined,
        ),
      ).toBe('at opening')
      await page.close()
    } finally {
      delete process.env['SHOTLIST_STEP_VALUE']
    }
  })

  it('keeps the Run environment namespace when a loop binds the same name', async () => {
    process.env['SHOTLIST_STEP_VALUE'] = 'from the Run'
    const domainRun = fixtureRun({ untrusted: false, env: ['SHOTLIST_STEP_VALUE'] })
    try {
      const { page } = await run(
        [
          {
            each: ['shadow'],
            as: 'env',
            steps: [{ fill: { css: '#inpTyped' }, value: '${env.SHOTLIST_STEP_VALUE}' }],
          },
        ],
        VERBS,
        new Map(),
        domainRun,
      )
      expect(
        await page.evaluate(
          () => (document.getElementById('inpTyped') as HTMLInputElement).value,
          undefined,
        ),
      ).toBe('from the Run')
      await page.close()
    } finally {
      delete process.env['SHOTLIST_STEP_VALUE']
    }
  })

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
