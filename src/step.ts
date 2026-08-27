import { z } from 'zod'
import { ShotlistError, distance, pageMessage } from './config.js'
import { checkUrl } from './trust.js'
import { makeQuery, resolveQuery } from './query.js'
import type { QueryInput, Rect } from './query.js'
import type { ElementHandle, Frame, Page, QueryTarget } from './playwright.js'
import type { Run } from './run.js'

/** A value a Step can hold literally or reference with `$name`. */
const Ref = z.union([z.string(), z.number(), z.boolean()])
const StepBase = { comment: z.string().optional() }

export type StepInput = Record<string, unknown>

export interface ResolvedStep {
  step: StepInput
  /** The variables in scope where this Step was written. */
  vars: Record<string, unknown>
  nested?: ResolvedStep[]
}

/** How the Run answers the browser's own dialogs, from the `dialog:` Step onwards. */
export interface DialogPolicy {
  action: 'accept' | 'dismiss'
  /** What a `prompt()` is answered with. An alert or confirm has nothing to type. */
  value?: string
}

/** What Step execution carries between Steps. */
export interface RunContext {
  pages: Map<string, Page>
  page: Page
  vars: Record<string, unknown>
  rects: Record<string, Rect>
  viewport: { width: number; height: number }
  timeout: number
  newPage(): Promise<Page>
  /** Set by `dialog:`. Unset, nothing is listening and the browser's default holds. */
  dialog?: DialogPolicy
}

type SchemaContext = {
  Query: z.ZodType<QueryInput>
  Step: z.ZodType<StepInput>
}

type AuthoredShape = {
  /** The schema for the value under the verb key. */
  value: z.ZodType
  /** Other fields accepted alongside the verb. */
  fields?: z.ZodRawShape
}

type ShapeFactory = (context: SchemaContext) => readonly [AuthoredShape, ...AuthoredShape[]]

type StepExecution = {
  run: Run
  resolved: ResolvedStep
  step: StepInput
  ctx: RunContext
  outer: Readonly<Record<string, unknown>>
  page: Page
  options: { timeout: number }
  query(key: string): QueryInput
  text(key: string): string
  element(key: string, verb: string): Promise<ElementHandle>
  nested(scope?: Readonly<Record<string, unknown>>): Promise<void>
}

type RuntimeDefinition = {
  verb: string
  shapes: ShapeFactory
  kind: 'runtime'
  execute(frame: StepExecution): Promise<void>
}

type BlockDefinition = {
  verb: string
  shapes: ShapeFactory
  kind: 'block'
  nested: 'steps' | 'optional'
  execute(frame: StepExecution): Promise<void>
}

type MacroDefinition = {
  verb: string
  shapes: ShapeFactory
  kind: 'macro'
}

type StepDefinition = RuntimeDefinition | BlockDefinition | MacroDefinition

/** Declare an ordinary built-in Step with its authored shape and runtime behavior. */
function runtimeStep<const Verb extends string>(
  verb: Verb,
  shapes: ShapeFactory,
  execute: RuntimeDefinition['execute'],
): RuntimeDefinition & { verb: Verb } {
  return { verb, shapes, kind: 'runtime', execute }
}

/** Declare a recursive built-in Step and the field containing its nested Steps. */
function blockStep<const Verb extends string>(
  verb: Verb,
  nested: BlockDefinition['nested'],
  shapes: ShapeFactory,
  execute: BlockDefinition['execute'],
): BlockDefinition & { verb: Verb } {
  return { verb, shapes, kind: 'block', nested, execute }
}

/** Declare a Step consumed by Macro expansion rather than Run execution. */
function macroStep<const Verb extends string>(
  verb: Verb,
  shapes: ShapeFactory,
): MacroDefinition & { verb: Verb } {
  return { verb, shapes, kind: 'macro' }
}

const DEFINITIONS = [
  runtimeStep(
    'goto',
    () => [{ value: z.string() }],
    async ({ run, page, text }) => {
      const to = text('goto')
      checkUrl(run.trust, to, '`goto`')
      await page.goto(to, { waitUntil: 'load' })
    },
  ),
  runtimeStep(
    'click',
    ({ Query }) => [{ value: Query }],
    async ({ element, options }) => {
      await (await element('click', 'click')).click(options)
    },
  ),
  runtimeStep(
    'dblclick',
    ({ Query }) => [{ value: Query }],
    async ({ element, options }) => {
      await (await element('dblclick', 'dblclick')).dblclick(options)
    },
  ),
  runtimeStep(
    'hover',
    ({ Query }) => [{ value: Query }],
    async ({ element, options }) => {
      await (await element('hover', 'hover')).hover(options)
    },
  ),
  runtimeStep(
    'fill',
    ({ Query }) => [{ value: Query, fields: { value: Ref } }],
    async ({ element, text, options }) => {
      await (await element('fill', 'fill')).fill(text('value'), options)
    },
  ),
  runtimeStep(
    'select',
    ({ Query }) => [
      {
        value: Query,
        fields: { option: Ref.optional(), optionLabel: z.string().optional() },
      },
    ],
    async ({ step, element, text, options }) => {
      const target = await element('select', 'select')
      const choice =
        step['optionLabel'] !== undefined ? { label: text('optionLabel') } : text('option')
      await target.selectOption(choice, options)
    },
  ),
  runtimeStep(
    'check',
    ({ Query }) => [{ value: Query }],
    async ({ element, options }) => {
      await (await element('check', 'check')).check(options)
    },
  ),
  runtimeStep(
    'uncheck',
    ({ Query }) => [{ value: Query }],
    async ({ element, options }) => {
      await (await element('uncheck', 'uncheck')).uncheck(options)
    },
  ),
  runtimeStep(
    'press',
    ({ Query }) => [{ value: z.string(), fields: { on: Query.optional() } }],
    async ({ step, element, text, page, options }) => {
      if (step['on'] !== undefined) {
        await (await element('on', 'press')).press(text('press'), options)
      } else {
        await page.keyboard.press(text('press'))
      }
    },
  ),
  runtimeStep(
    'type',
    ({ Query }) => [{ value: z.string(), fields: { on: Query.optional() } }],
    async ({ step, element, text, page, options }) => {
      if (step['on'] !== undefined) {
        await (await element('on', 'type')).type(text('type'), options)
      } else {
        await page.keyboard.type(text('type'))
      }
    },
  ),
  runtimeStep(
    'blur',
    ({ Query }) => [{ value: Query }],
    async ({ element }) => {
      const target = await element('blur', 'blur')
      await target.evaluate((node) => (node as HTMLElement).blur())
    },
  ),
  runtimeStep(
    'scrollIntoView',
    ({ Query }) => [{ value: Query }],
    async ({ element, options }) => {
      await (await element('scrollIntoView', 'scrollIntoView')).scrollIntoViewIfNeeded(options)
    },
  ),
  runtimeStep(
    'wait',
    ({ Query }) => [{ value: z.union([z.number(), Query]) }],
    async ({ step, query, page, ctx }) => {
      if (typeof step['wait'] === 'number') {
        await page.waitForTimeout(step['wait'])
      } else {
        await waitFor(page, query('wait'), ctx)
      }
    },
  ),
  runtimeStep(
    'dialog',
    () => [
      { value: z.literal('accept'), fields: { value: Ref.optional() } },
      { value: z.literal('dismiss') },
    ],
    async ({ step, text, page, ctx }) => {
      ctx.dialog = {
        action: text('dialog') as DialogPolicy['action'],
        ...(step['value'] === undefined ? {} : { value: text('value') }),
      }
      answerDialogs(page, ctx)
    },
  ),
  runtimeStep(
    'readValue',
    ({ Query }) => [{ value: Query, fields: { as: z.string() } }],
    async ({ element, text, ctx, options }) => {
      const target = await element('readValue', 'readValue')
      ctx.vars[text('as')] = await target.inputValue(options)
    },
  ),
  macroStep('use', () => [
    { value: z.string(), fields: { with: z.record(z.string(), z.unknown()).optional() } },
  ]),
  blockStep(
    'repeat',
    'steps',
    ({ Step }) => [
      {
        value: z.int().positive().max(1000),
        fields: { steps: z.array(Step) },
      },
    ],
    async ({ step, nested }) => {
      for (let index = 0; index < Number(step['repeat']); index++) await nested()
    },
  ),
  blockStep(
    'each',
    'steps',
    ({ Step }) => [
      {
        value: z.union([z.string(), z.array(z.unknown())]),
        fields: { as: z.string().default('item'), steps: z.array(Step) },
      },
    ],
    async ({ step, text, outer, nested }) => {
      const items = step['each']
      if (!Array.isArray(items)) {
        throw new ShotlistError(`\`each\` needs a list, and ${JSON.stringify(items)} is not one`)
      }
      const name = text('as')
      for (const item of items) await nested({ ...outer, [name]: item })
    },
  ),
  blockStep(
    'optional',
    'optional',
    ({ Step }) => [{ value: z.array(Step) }],
    async ({ nested }) => {
      try {
        await nested()
      } catch {
        // `optional` exists for the dialog that is sometimes already closed.
      }
    },
  ),
  runtimeStep(
    'openPage',
    () => [
      {
        value: z.string(),
        fields: {
          as: z.string(),
          viewport: z.object({ width: z.number(), height: z.number() }).optional(),
        },
      },
    ],
    async ({ run, step, text, ctx }) => {
      const to = text('openPage')
      checkUrl(run.trust, to, '`openPage`')
      const opened = await ctx.newPage()
      const viewport = step['viewport'] as { width: number; height: number } | undefined
      if (viewport) await opened.setViewportSize(viewport)
      await opened.goto(to, { waitUntil: 'load' })
      ctx.pages.set(text('as'), opened)
      ctx.page = opened
    },
  ),
  runtimeStep(
    'usePage',
    () => [{ value: z.string() }],
    async ({ text, ctx }) => {
      const named = ctx.pages.get(text('usePage'))
      if (!named) {
        const known = [...ctx.pages.keys()]
        throw new ShotlistError(
          `no page named "${text('usePage')}"` +
            (known.length ? ` — open pages: ${known.join(', ')}` : ''),
        )
      }
      ctx.page = named
    },
  ),
] as const satisfies readonly StepDefinition[]

type VerbTuple<Definitions extends readonly { verb: string }[]> = {
  readonly [Index in keyof Definitions]: Definitions[Index] extends {
    verb: infer Verb extends string
  }
    ? Verb
    : never
}

/** Project a declaration tuple into its ordered verb names. */
function verbsOf<const Definitions extends readonly { verb: string }[]>(
  definitions: Definitions,
): VerbTuple<Definitions> {
  return definitions.map((definition) => definition.verb) as VerbTuple<Definitions>
}

/** Every verb a Step may lead with, derived from the built-in declarations. */
export const VERBS = verbsOf(DEFINITIONS)

const BY_VERB = new Map<string, StepDefinition>(
  DEFINITIONS.map((definition) => [definition.verb, definition]),
)
const NESTED_KEYS = new Set(
  DEFINITIONS.flatMap((definition) => (definition.kind === 'block' ? [definition.nested] : [])),
)
if (BY_VERB.size !== DEFINITIONS.length) throw new Error('built-in Step verbs must be unique')

/** The declaration matching any recognized key in a Step mapping. */
function definitionFor(step: StepInput): StepDefinition | undefined {
  for (const key of Object.keys(step)) {
    const definition = BY_VERB.get(key)
    if (definition) return definition
  }
  return undefined
}

/** Build the recursive Step schema against one Project's Finders. */
export function makeStep(finders: Readonly<Record<string, unknown>>): z.ZodType<StepInput> {
  const Query = makeQuery(finders)
  const Step: z.ZodType<StepInput> = z.lazy(() => {
    const branches = DEFINITIONS.flatMap((definition) =>
      definition.shapes({ Query, Step }).map(({ value, fields = {} }) => {
        if (definition.kind === 'block') {
          const nested = definition.nested === definition.verb ? value : fields[definition.nested]
          if (!(nested instanceof z.ZodArray)) {
            throw new Error(
              `built-in Step "${definition.verb}" must declare ${definition.nested} as nested Steps`,
            )
          }
        }
        return z.object({ [definition.verb]: value, ...fields, ...StepBase }).strict()
      }),
    )
    return z.union(
      branches as unknown as [
        z.ZodType<StepInput>,
        z.ZodType<StepInput>,
        ...z.ZodType<StepInput>[],
      ],
    )
  })
  return Step
}

/** Return the closest known Step verb when one is near enough to help. */
export function nearestVerb(word: string): string | null {
  let best: string | null = null
  let score = Infinity
  for (const verb of VERBS) {
    const candidate = distance(word.toLowerCase(), verb.toLowerCase())
    if (candidate < score) {
      score = candidate
      best = verb
    }
  }
  return score <= Math.max(2, Math.floor(word.length / 3)) ? best : null
}

/** Check a raw Step tree before Zod expands one typo into every union branch. */
export function checkStepVerbs(steps: unknown, where: string): void {
  if (!Array.isArray(steps)) throw new ShotlistError(`${where}: expected a list of steps`)
  steps.forEach((step, index) => {
    const at = `${where}[${index}]`
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw new ShotlistError(`${at}: a step must be a mapping like \`click: {…}\``)
    }
    const mapping = step as StepInput
    const definition = definitionFor(mapping)
    if (!definition) {
      const [first] = Object.keys(mapping)
      const suggestion = first ? nearestVerb(first) : null
      throw new ShotlistError(
        `${at}: unknown step "${first ?? '(empty)'}"` +
          (suggestion ? ` — did you mean "${suggestion}"?` : ` — known steps: ${VERBS.join(', ')}`),
      )
    }
    for (const nested of NESTED_KEYS) {
      if (Array.isArray(mapping[nested])) checkStepVerbs(mapping[nested], `${at}.${nested}`)
    }
  })
}

/** Expand Macro use and nested Steps before Run execution. */
export function expandSteps(
  steps: readonly StepInput[],
  macros: ReadonlyMap<
    string,
    {
      readonly defaults: Readonly<Record<string, unknown>>
      readonly steps: readonly StepInput[]
    }
  >,
  vars: Record<string, unknown> = {},
  seen: readonly string[] = [],
): ResolvedStep[] {
  return steps.flatMap((step): ResolvedStep[] => {
    const definition = definitionFor(step)
    if (definition?.kind === 'macro' && typeof step['use'] === 'string') {
      const name = step['use']
      const macro = macros.get(name)
      if (!macro) {
        const known = [...macros.keys()].sort()
        throw new ShotlistError(
          `unknown macro "${name}"` +
            (known.length ? ` — this project defines ${known.join(', ')}` : ''),
        )
      }
      if (seen.includes(name)) {
        throw new ShotlistError(`macro "${name}" uses itself (${[...seen, name].join(' → ')})`)
      }
      const frame = { ...vars, ...macro.defaults, ...((step['with'] as object) ?? {}) }
      return expandSteps(macro.steps, macros, frame, [...seen, name])
    }
    if (definition?.kind === 'block' && Array.isArray(step[definition.nested])) {
      return [
        {
          step,
          vars,
          nested: expandSteps(step[definition.nested] as StepInput[], macros, vars, seen),
        },
      ]
    }
    return [{ step, vars }]
  })
}

/** The scope a Recipe reads the operator's variables through: `${env.NAME}`. */
export const ENV = 'env'

/** Explain why an environment reference did not resolve. */
function noEnv(reference: string, name: string): ShotlistError {
  return new ShotlistError(
    `no value for ${reference} — either ${name} is not set, or nothing allowed it. ` +
      `Add it to \`allowEnv\` in the config, or pass \`--allow-env ${name}\`.`,
  )
}

/** Resolve `$name` references against the variables in scope. */
export function interpolate(
  value: unknown,
  vars: Readonly<Record<string, unknown>>,
  missing: 'throw' | 'keep' = 'throw',
): unknown {
  if (typeof value === 'string') {
    const whole = /^\$\{?([A-Za-z_][\w.]*)\}?$/.exec(value)
    if (whole) {
      const resolved = lookup(vars, whole[1]!)
      if (resolved !== undefined) return resolved
      if (missing === 'keep') return value
      if (whole[1]!.startsWith(`${ENV}.`)) throw noEnv(value, whole[1]!.slice(ENV.length + 1))
      throw new ShotlistError(`no value for ${value}`)
    }
    return value.replace(/\$\{?([A-Za-z_][\w.]*)\}?/g, (all, path: string) => {
      const resolved = lookup(vars, path)
      if (resolved !== undefined) return String(resolved)
      if (missing === 'throw' && path.startsWith(`${ENV}.`)) {
        throw noEnv(all, path.slice(ENV.length + 1))
      }
      return all
    })
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, vars, missing))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, interpolate(inner, vars, missing)]),
    )
  }
  return value
}

const NOT_DATA = new Set(['__proto__', 'constructor', 'prototype'])

/** Read a dotted path from the variable scope and nowhere else. */
function lookup(vars: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    if (NOT_DATA.has(key) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined
    return (current as Record<string, unknown>)[key]
  }, vars)
}

/** Pages already answering from the Run policy, so each receives one listener. */
const ANSWERING = new WeakSet<Page>()

/** Have a page answer dialogs using the current standing policy. */
function answerDialogs(page: Page, ctx: RunContext): void {
  if (ANSWERING.has(page)) return
  ANSWERING.add(page)
  page.on('dialog', (dialog) => {
    const policy = ctx.dialog
    const answered = policy?.action === 'accept' ? dialog.accept(policy.value) : dialog.dismiss()
    void answered.catch(() => {})
  })
}

const LOCATOR_SOURCES = ['role', 'label', 'placeholder', 'testid'] as const

/** Ask Playwright for candidates requiring its locator engine. */
async function seedsFor(
  page: QueryTarget,
  query: QueryInput,
): Promise<ElementHandle[] | undefined> {
  if ('span' in query || 'rect' in query) return undefined
  const candidate = query as Record<string, unknown>
  if (!LOCATOR_SOURCES.some((key) => candidate[key] !== undefined)) return undefined
  const exact = candidate['exact'] === undefined ? undefined : Boolean(candidate['exact'])
  if (typeof candidate['role'] === 'string') {
    const options: Record<string, unknown> = {}
    if (typeof candidate['name'] === 'string') options['name'] = candidate['name']
    if (exact !== undefined) options['exact'] = exact
    return page.getByRole(candidate['role'], options).elementHandles()
  }
  if (typeof candidate['label'] === 'string') {
    return page
      .getByLabel(candidate['label'], exact === undefined ? {} : { exact })
      .elementHandles()
  }
  if (typeof candidate['placeholder'] === 'string') {
    return page
      .getByPlaceholder(candidate['placeholder'], exact === undefined ? {} : { exact })
      .elementHandles()
  }
  return page.getByTestId(String(candidate['testid'])).elementHandles()
}

/** Locate a frame's document origin in top-page coordinates. */
async function frameOrigin(
  frame: Frame,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const element = await frame.frameElement()
  const box = await element.boundingBox()
  if (!box) {
    throw new ShotlistError('the iframe is not rendered, so nothing inside it has a position')
  }
  const inset = await element.evaluate((node: Element) => {
    const style = getComputedStyle(node)
    return {
      left: parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      top: parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
    }
  })
  return { x: box.x + inset.left, y: box.y + inset.top, width: box.width, height: box.height }
}

/** Enter the frame a Query names and remove the `frame` key from the inner Query. */
async function intoFrame(
  target: QueryTarget,
  query: QueryInput,
  ctx: Pick<RunContext, 'rects' | 'viewport'> & { timeout?: number },
): Promise<{ frame: Frame; rest: QueryInput; origin: { x: number; y: number } }> {
  const { frame: spec, ...rest } = query as { frame: QueryInput } & Record<string, unknown>
  const found = await resolve(target, spec, ctx)
  if (!found.element) {
    throw new ShotlistError(`\`frame\`: ${JSON.stringify(spec)} is a box, not an iframe`)
  }
  const frame = await found.element.contentFrame()
  if (!frame) {
    throw new ShotlistError(
      `\`frame\`: ${JSON.stringify(spec)} matched an element that is not an iframe`,
    )
  }
  return { frame, rest: rest as QueryInput, origin: await frameOrigin(frame) }
}

/** Resolve a Query in a page or frame, retaining both its rectangle and element. */
export async function resolve(
  page: QueryTarget,
  query: QueryInput,
  ctx: Pick<RunContext, 'rects' | 'viewport'> & { timeout?: number; all?: boolean },
): Promise<{ rect: Rect; element: ElementHandle | null; rects?: Rect[] }> {
  if (query !== null && typeof query === 'object' && 'frame' in query) {
    const { frame, rest, origin } = await intoFrame(page, query, ctx)
    if ('within' in rest && typeof (rest as { within: unknown }).within === 'string') {
      throw new ShotlistError(
        '`within` names a rect from the page, and `frame` looks in another document — ' +
          'give the query inside the frame its own `within`, or drop it',
      )
    }
    const found = await resolve(frame, rest, { ...ctx, rects: {} })
    const move = (rect: Rect): Rect => ({ ...rect, x: rect.x + origin.x, y: rect.y + origin.y })
    return {
      ...found,
      rect: move(found.rect),
      ...(found.rects ? { rects: found.rects.map(move) } : {}),
    }
  }
  const budget = ctx.timeout ?? 15000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const seeds = await seedsFor(page, query)
    const overran = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new ShotlistError(
            `gave up after ${budget}ms resolving ${JSON.stringify(query)} — a \`matching\` ` +
              'pattern that has to backtrack can take effectively forever on the wrong text. ' +
              '`site.timeout` is the limit.',
          ),
        )
      }, budget)
    })
    const handle = await Promise.race([
      page.evaluateHandle(resolveQuery, {
        spec: query,
        viewport: ctx.viewport,
        rects: ctx.rects,
        ...(ctx.all ? { all: true } : {}),
        ...(seeds ? { seeds: seeds as unknown as Element[] } : {}),
      }),
      overran,
    ])
    const rect = await handle.evaluate((result) => result.rect)
    const rects = await handle.evaluate((result) => result.rects)
    const element = (await handle.getProperty('element')).asElement()
    await handle.dispose()
    return { rect, element, ...(rects ? { rects } : {}) }
  } catch (error) {
    throw error instanceof ShotlistError ? error : new ShotlistError(pageMessage(error))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Resolve a Query to an element or explain why it only produced a rectangle. */
async function elementFor(
  page: Page,
  query: QueryInput,
  ctx: RunContext,
  verb: string,
): Promise<ElementHandle> {
  let found: { element: ElementHandle | null }
  try {
    found = await resolve(page, query, ctx)
  } catch (error) {
    throw new ShotlistError(`\`${verb}\`: ${(error as Error).message}`)
  }
  if (!found.element) {
    throw new ShotlistError(`\`${verb}\` needs an element, and ${JSON.stringify(query)} is a box`)
  }
  return found.element
}

/** Execute expanded Steps serially after the public facade authenticates the Run. */
export async function executeSteps(
  run: Run,
  steps: readonly ResolvedStep[],
  ctx: RunContext,
  outer: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  for (const resolved of steps) await executeStep(run, resolved, ctx, outer)
}

/** Interpolate and execute one expanded Step through its declaration. */
async function executeStep(
  run: Run,
  resolved: ResolvedStep,
  ctx: RunContext,
  outer: Readonly<Record<string, unknown>>,
): Promise<void> {
  const environment = { [ENV]: run.env }
  const enclosing = { ...ctx.vars, ...outer, ...environment }
  const args = interpolate(resolved.vars, enclosing, 'keep') as Record<string, unknown>
  const scope = { ...enclosing, ...args, ...environment }
  const definition = definitionFor(resolved.step)
  const own: StepInput = {}
  for (const [key, value] of Object.entries(resolved.step)) {
    own[key] =
      NESTED_KEYS.has(key as BlockDefinition['nested']) && Array.isArray(value) ? [] : value
  }
  const step = interpolate(own, scope) as StepInput
  const page = ctx.page
  if (ctx.dialog) answerDialogs(page, ctx)
  if (!definition || definition.kind === 'macro') {
    throw new ShotlistError(`unrecognized step ${JSON.stringify(step)}`)
  }
  const query = (key: string) => step[key] as QueryInput
  const text = (key: string) => String(step[key])
  await definition.execute({
    run,
    resolved,
    step,
    ctx,
    outer,
    page,
    options: { timeout: ctx.timeout },
    query,
    text,
    element: (key, verb) => elementFor(page, query(key), ctx, verb),
    nested: (nestedScope = outer) => executeSteps(run, resolved.nested ?? [], ctx, nestedScope),
  })
}

/** Poll until a Query resolves, preserving the last failure on timeout. */
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
