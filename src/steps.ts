import { ShotlistError } from './config.js'
import { interpolate } from './recipe.js'
import { resolveQuery } from './query.js'
import type { QueryInput, Rect } from './query.js'
import type { ResolvedStep, StepInput } from './recipe.js'
import type { ElementHandle, Page } from './playwright.js'

/** What the runner carries between steps: the pages open, and what has been read so far. */
export interface RunContext {
  pages: Map<string, Page>
  page: Page
  vars: Record<string, unknown>
  rects: Record<string, Rect>
  viewport: { width: number; height: number }
  timeout: number
  newPage(): Promise<Page>
}

const LOCATOR_SOURCES = ['role', 'label', 'placeholder', 'testid'] as const

/** Elements Playwright's own engine can find, for the sources that need ARIA or labels. */
async function seedsFor(page: Page, query: QueryInput): Promise<ElementHandle[] | undefined> {
  if ('span' in query || 'rect' in query) return undefined
  const q = query as Record<string, unknown>
  if (!LOCATOR_SOURCES.some((key) => q[key] !== undefined)) return undefined

  const exact = q['exact'] === undefined ? undefined : Boolean(q['exact'])
  if (typeof q['role'] === 'string') {
    const options: Record<string, unknown> = {}
    if (typeof q['name'] === 'string') options['name'] = q['name']
    if (exact !== undefined) options['exact'] = exact
    return page.getByRole(q['role'], options).elementHandles()
  }
  if (typeof q['label'] === 'string')
    return page.getByLabel(q['label'], exact === undefined ? {} : { exact }).elementHandles()
  if (typeof q['placeholder'] === 'string')
    return page
      .getByPlaceholder(q['placeholder'], exact === undefined ? {} : { exact })
      .elementHandles()
  return page.getByTestId(String(q['testid'])).elementHandles()
}

/** Resolve a query in the page, returning both the box and the element it found. */
export async function resolve(
  page: Page,
  query: QueryInput,
  ctx: Pick<RunContext, 'rects' | 'viewport'>,
): Promise<{ rect: Rect; element: ElementHandle | null }> {
  const seeds = await seedsFor(page, query)
  const handle = await page.evaluateHandle(resolveQuery, {
    spec: query,
    viewport: ctx.viewport,
    rects: ctx.rects,
    ...(seeds ? { seeds: seeds as unknown as Element[] } : {}),
  })
  const rect = await handle.evaluate((r) => r.rect)
  const element = (await handle.getProperty('element')).asElement()
  await handle.dispose()
  return { rect, element }
}

/** Resolve a query to an element, failing with the query itself when nothing matched. */
async function elementFor(
  page: Page,
  query: QueryInput,
  ctx: RunContext,
  verb: string,
): Promise<ElementHandle> {
  const { element } = await resolve(page, query, ctx)
  if (!element) {
    throw new ShotlistError(`\`${verb}\` needs an element, and ${JSON.stringify(query)} is a box`)
  }
  return element
}

/**
 * Run one recipe's steps against the page, in order.
 *
 * `scope` carries the variables a loop has bound. It flows down the whole subtree rather
 * than being stamped onto each step: a macro used inside a loop may loop again, and the
 * steps two levels down still need the outer loop's variable.
 */
export async function runSteps(
  steps: readonly ResolvedStep[],
  ctx: RunContext,
  scope: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  for (const resolved of steps) await runStep(resolved, ctx, scope)
}

/** Run one step, with `$name` resolved against the variables in scope where it was written. */
async function runStep(
  resolved: ResolvedStep,
  ctx: RunContext,
  outer: Readonly<Record<string, unknown>>,
): Promise<void> {
  // A macro's own arguments beat a loop variable of the same name: `with:` is the more
  // specific statement of the two.
  //
  // They are resolved here rather than where the frame was built, because an argument may
  // name a loop variable — `use: set-hp` `with: {who: $foe}` inside an `each` — and the
  // frames are built when the file loads, before `$foe` stands for anything.
  const enclosing = { ...ctx.vars, ...outer }
  const args = interpolate(resolved.vars, enclosing, 'keep') as Record<string, unknown>
  const scope = { ...enclosing, ...args }
  // A block's own keys resolve now; the steps inside it do not. `each` binds its loop
  // variable when it runs, so interpolating its children here would look for a value
  // that only exists one level down.
  const own: StepInput = {}
  for (const [key, value] of Object.entries(resolved.step)) {
    own[key] = (key === 'steps' || key === 'optional') && Array.isArray(value) ? [] : value
  }
  const step = interpolate(own, scope) as StepInput
  const opts = { timeout: ctx.timeout }
  const page = ctx.page

  const query = (key: string) => step[key] as QueryInput
  const text = (key: string) => String(step[key])

  if ('goto' in step) {
    await page.goto(text('goto'), { waitUntil: 'load' })
    return
  }
  if ('click' in step) {
    await (await elementFor(page, query('click'), ctx, 'click')).click(opts)
    return
  }
  if ('dblclick' in step) {
    await (await elementFor(page, query('dblclick'), ctx, 'dblclick')).dblclick(opts)
    return
  }
  if ('hover' in step) {
    await (await elementFor(page, query('hover'), ctx, 'hover')).hover(opts)
    return
  }
  if ('fill' in step) {
    await (await elementFor(page, query('fill'), ctx, 'fill')).fill(text('value'), opts)
    return
  }
  if ('select' in step) {
    const element = await elementFor(page, query('select'), ctx, 'select')
    const choice =
      step['optionLabel'] !== undefined ? { label: text('optionLabel') } : text('option')
    await element.selectOption(choice, opts)
    return
  }
  if ('check' in step) {
    await (await elementFor(page, query('check'), ctx, 'check')).check(opts)
    return
  }
  if ('uncheck' in step) {
    await (await elementFor(page, query('uncheck'), ctx, 'uncheck')).uncheck(opts)
    return
  }
  if ('press' in step) {
    if (step['on'] !== undefined) {
      await (await elementFor(page, query('on'), ctx, 'press')).press(text('press'), opts)
    } else {
      await page.keyboard.press(text('press'))
    }
    return
  }
  if ('type' in step) {
    if (step['on'] !== undefined) {
      await (await elementFor(page, query('on'), ctx, 'type')).type(text('type'), opts)
    } else {
      await page.keyboard.type(text('type'))
    }
    return
  }
  if ('blur' in step) {
    const element = await elementFor(page, query('blur'), ctx, 'blur')
    await element.evaluate((el) => (el as HTMLElement).blur())
    return
  }
  if ('scrollIntoView' in step) {
    const element = await elementFor(page, query('scrollIntoView'), ctx, 'scrollIntoView')
    await element.scrollIntoViewIfNeeded(opts)
    return
  }
  if ('wait' in step) {
    if (typeof step['wait'] === 'number') {
      await page.waitForTimeout(step['wait'])
      return
    }
    await waitFor(page, query('wait'), ctx)
    return
  }
  if ('readValue' in step) {
    const element = await elementFor(page, query('readValue'), ctx, 'readValue')
    ctx.vars[text('as')] = await element.inputValue(opts)
    return
  }
  if ('repeat' in step) {
    const times = Number(step['repeat'])
    for (let i = 0; i < times; i++) await runSteps(resolved.nested ?? [], ctx, outer)
    return
  }
  if ('each' in step) {
    const items = step['each']
    if (!Array.isArray(items)) {
      throw new ShotlistError(`\`each\` needs a list, and ${JSON.stringify(items)} is not one`)
    }
    const name = text('as')
    for (const item of items) {
      await runSteps(resolved.nested ?? [], ctx, { ...outer, [name]: item })
    }
    return
  }
  if ('optional' in step) {
    try {
      await runSteps(resolved.nested ?? [], ctx, outer)
    } catch {
      // `optional` exists for the dialog that is sometimes already closed.
    }
    return
  }
  if ('openPage' in step) {
    const opened = await ctx.newPage()
    const viewport = step['viewport'] as { width: number; height: number } | undefined
    if (viewport) await opened.setViewportSize(viewport)
    await opened.goto(text('openPage'), { waitUntil: 'load' })
    ctx.pages.set(text('as'), opened)
    ctx.page = opened
    return
  }
  if ('usePage' in step) {
    const named = ctx.pages.get(text('usePage'))
    if (!named) {
      const known = [...ctx.pages.keys()]
      throw new ShotlistError(
        `no page named "${text('usePage')}"` +
          (known.length ? ` — open pages: ${known.join(', ')}` : ''),
      )
    }
    ctx.page = named
    return
  }
  throw new ShotlistError(`unrecognised step ${JSON.stringify(step)}`)
}

/**
 * Poll until a query resolves.
 *
 * The query language reaches elements Playwright's selectors cannot express, so waiting
 * on one means asking it repeatedly rather than handing a selector to `waitForSelector`.
 */
async function waitFor(page: Page, query: QueryInput, ctx: RunContext): Promise<void> {
  const deadline = Date.now() + ctx.timeout
  let last: unknown
  for (;;) {
    try {
      await resolve(page, query, ctx)
      return
    } catch (error) {
      last = error
      if (Date.now() > deadline) {
        throw new ShotlistError(
          `waited ${ctx.timeout}ms for ${JSON.stringify(query)} — ${(last as Error).message}`,
        )
      }
      await page.waitForTimeout(100)
    }
  }
}
