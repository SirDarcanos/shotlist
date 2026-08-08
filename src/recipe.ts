import { readdirSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import { ShotlistError, formatIssues, readDocument } from './config.js'
import { makeQuery } from './query.js'
import type { QueryInput } from './query.js'

/** A value a recipe can hold literally or reference with `$name`. */
const Ref = z.union([z.string(), z.number(), z.boolean()])

const StepBase = { comment: z.string().optional() }

/** The step vocabulary, bound to a project's query aliases. */
function makeStep(aliases: Readonly<Record<string, unknown>>): z.ZodType<StepInput> {
  const Query = makeQuery(aliases)
  const Step: z.ZodType<StepInput> = z.lazy(() =>
    z.union([
      z.object({ goto: z.string(), ...StepBase }).strict(),
      z.object({ click: Query, ...StepBase }).strict(),
      z.object({ dblclick: Query, ...StepBase }).strict(),
      z.object({ hover: Query, ...StepBase }).strict(),
      z.object({ fill: Query, value: Ref, ...StepBase }).strict(),
      z
        .object({
          select: Query,
          option: Ref.optional(),
          optionLabel: z.string().optional(),
          ...StepBase,
        })
        .strict(),
      z.object({ check: Query, ...StepBase }).strict(),
      z.object({ uncheck: Query, ...StepBase }).strict(),
      z.object({ press: z.string(), on: Query.optional(), ...StepBase }).strict(),
      z.object({ type: z.string(), on: Query.optional(), ...StepBase }).strict(),
      z.object({ blur: Query, ...StepBase }).strict(),
      z.object({ scrollIntoView: Query, ...StepBase }).strict(),
      z.object({ wait: z.union([z.number(), Query]), ...StepBase }).strict(),
      z.object({ readValue: Query, as: z.string(), ...StepBase }).strict(),
      z
        .object({
          use: z.string(),
          with: z.record(z.string(), z.unknown()).optional(),
          ...StepBase,
        })
        .strict(),
      z.object({ repeat: z.number().int().positive(), steps: z.array(Step), ...StepBase }).strict(),
      z
        .object({
          each: z.union([z.string(), z.array(z.unknown())]),
          as: z.string().default('item'),
          steps: z.array(Step),
          ...StepBase,
        })
        .strict(),
      z.object({ optional: z.array(Step), ...StepBase }).strict(),
      z
        .object({
          openPage: z.string(),
          as: z.string(),
          viewport: z.object({ width: z.number(), height: z.number() }).optional(),
          ...StepBase,
        })
        .strict(),
      z.object({ usePage: z.string(), ...StepBase }).strict(),
    ]),
  )
  return Step
}

export type StepInput = Record<string, unknown>

/** Every verb a step may lead with — the vocabulary, and the source of did-you-mean. */
export const VERBS = [
  'goto',
  'click',
  'dblclick',
  'hover',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'type',
  'blur',
  'scrollIntoView',
  'wait',
  'readValue',
  'use',
  'repeat',
  'each',
  'optional',
  'openPage',
  'usePage',
] as const

const Callout = z
  .object({
    mark: z.string(),
    /** One line, or several. */
    text: z.union([z.string(), z.array(z.string())]).optional(),
    n: z.int().positive().optional(),
    /**
     * Which side of the mark the label sits on. `auto` weighs what each side would cost
     * the canvas against what its arrow would have to cross, and is right often enough
     * to be the default; name a side when the shot needs one.
     */
    place: z.enum(['left', 'right', 'top', 'bottom', 'corner', 'auto']).default('auto'),
    /** One of eight anchors on the box: a corner, or the middle of an edge. */
    badge: z.enum(['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br']).default('tl'),
    box: z.boolean().default(true),
    /**
     * Whether the label or disc sits over the screenshot rather than in a margin the
     * canvas grows to make. Left unsaid, a disc goes inside and a label on a named side
     * goes outside; with `place: auto` it is decided from what the shot has under it.
     */
    inside: z.boolean().optional(),
    /** Nudge, in image pixels, for what geometry alone cannot place. */
    dx: z.number().optional(),
    dy: z.number().optional(),
    pad: z.number().optional(),
    gap: z.number().optional(),
  })
  .strict()

/** `numbered:` as a plain list, or as a list with the style every disc shares. */
const Numbered = z.union([
  z.array(z.string()),
  z
    .object({
      marks: z.array(z.string()),
      box: z.boolean().default(true),
      badge: z.enum(['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br']).default('tl'),
      inside: z.boolean().default(true),
      dx: z.number().optional(),
      dy: z.number().optional(),
      pad: z.number().optional(),
    })
    .strict(),
])

const StylePatch = z.record(z.string(), z.unknown())

/** The recipe schema, bound to a project's query aliases. */
export function makeRecipe(aliases: Readonly<Record<string, unknown>> = {}) {
  const Query = makeQuery(aliases)
  return z
    .object({
      name: z.string().optional(),
      source: z.enum(['app', 'file']).default('app'),
      /** With `source: file`, the PNG to annotate instead of driving the site. */
      file: z.string().optional(),
      install: z.string().optional(),
      url: z.string().optional(),
      viewport: z.object({ width: z.number(), height: z.number() }).optional(),
      scale: z.number().positive().optional(),
      theme: z.enum(['light', 'dark', 'no-preference']).optional(),
      style: StylePatch.optional(),
      setup: z.array(makeStep(aliases)).default([]),
      clip: z.union([z.literal('viewport'), z.literal('full'), Query]).default('viewport'),
      marks: z.record(z.string(), Query).default({}),
      /**
       * Regions painted over before the callouts are drawn, for what the recipe does not
       * decide: a clock, a live total, a face. Without them a shot holding one thing that
       * changes has to give up `--check` entirely, and a staleness check that always
       * reports a change is one nobody reads.
       */
      mask: z.array(Query).default([]),
      callouts: z.array(Callout).default([]),
      /** Shorthand: number these marks 1..n, in order, with a disc on each box. */
      numbered: Numbered.optional(),
      /**
       * How many times to shoot this again if it fails. A capture drives a real
       * application, and what it trips over — an element that had not rendered yet, a
       * request that had not landed — is often gone on the next attempt.
       *
       * Capped, because a recipe whose query is simply wrong fails identically every
       * time, and the only thing a large number buys is a slower way to be told so.
       */
      retries: z.int().min(0).max(5).default(0),
      /**
       * How `--check` treats this recipe. `false` never diffs it, for a shot whose
       * content the recipe does not control — live dice, a clock, anything the
       * application decides for itself.
       */
      check: z
        .union([
          z.literal(false),
          z
            .object({
              threshold: z.number().min(0).max(1).optional(),
              tolerance: z.number().min(0).max(255).optional(),
              /**
               * Regions whose contents are not compared, for a shot that is worth
               * checking apart from the part of it the recipe does not decide.
               *
               * The region is shot as it is — unlike `mask`, nothing is painted over
               * it — and blanked in both images before they are diffed. It is blanked
               * at the place it resolves to now, so the box moving or changing size is
               * still reported: what is excused is the content, not the geometry.
               */
              ignore: z.array(Query).default([]),
            })
            .strict(),
        ])
        .optional(),
    })
    .strict()
}

/** The macro schema, bound to a project's query aliases. */
export function makeMacro(aliases: Readonly<Record<string, unknown>> = {}) {
  return z
    .object({
      name: z.string().optional(),
      defaults: z.record(z.string(), z.unknown()).default({}),
      steps: z.array(makeStep(aliases)),
    })
    .strict()
}

/** The alias-free schemas, for typing and for generating the JSON Schema. */
export const Recipe = makeRecipe()
export const Macro = makeMacro()

export type Recipe = z.infer<typeof Recipe>
export type Callout = z.infer<typeof Callout>
export type Macro = z.infer<typeof Macro>

/** Edit distance, for suggesting the verb an author meant. */
function distance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ])
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return rows[a.length]![b.length]!
}

/** The closest known verb to `word`, when one is close enough to be worth suggesting. */
export function nearestVerb(word: string): string | null {
  let best: string | null = null
  let score = Infinity
  for (const verb of VERBS) {
    const d = distance(word.toLowerCase(), verb.toLowerCase())
    if (d < score) {
      score = d
      best = verb
    }
  }
  return score <= Math.max(2, Math.floor(word.length / 3)) ? best : null
}

/**
 * Check a step leads with a known verb before zod does.
 *
 * A union of twenty strict objects produces twenty parallel failures for one typo,
 * none of which says "clik". This catches it first and says so.
 */
function checkVerb(step: unknown, where: string): void {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) {
    throw new ShotlistError(`${where}: a step must be a mapping like \`click: {…}\``)
  }
  const keys = Object.keys(step)
  if (keys.some((key) => (VERBS as readonly string[]).includes(key))) return
  const [first] = keys
  const suggestion = first ? nearestVerb(first) : null
  throw new ShotlistError(
    `${where}: unknown step "${first ?? '(empty)'}"` +
      (suggestion ? ` — did you mean "${suggestion}"?` : ` — known steps: ${VERBS.join(', ')}`),
  )
}

/** Walk a step tree, checking every verb, including the nested ones. */
function checkVerbs(steps: unknown, where: string): void {
  if (!Array.isArray(steps)) throw new ShotlistError(`${where}: expected a list of steps`)
  steps.forEach((step, index) => {
    const at = `${where}[${index}]`
    checkVerb(step, at)
    const nested = step as Record<string, unknown>
    if (Array.isArray(nested['steps'])) checkVerbs(nested['steps'], `${at}.steps`)
    if (Array.isArray(nested['optional'])) checkVerbs(nested['optional'], `${at}.optional`)
  })
}

/**
 * Run a schema, turning both kinds of failure into one error an author can act on.
 *
 * Alias expansion happens inside the schema and throws rather than adding an issue,
 * so a bad finder name and a bad field arrive by different routes and have to meet
 * here.
 */
function validate<T>(schema: z.ZodType<T>, raw: unknown, what: string, file?: string): T {
  let result: z.ZodSafeParseResult<T>
  try {
    result = schema.safeParse(raw)
  } catch (error) {
    throw new ShotlistError((error as Error).message, file)
  }
  if (!result.success) {
    throw new ShotlistError(`invalid ${what} —\n${formatIssues(result.error)}`, file)
  }
  return result.data
}

/** Validate one recipe document against this project's aliases. */
export function parseRecipe(
  raw: unknown,
  options: { finders?: Record<string, unknown>; file?: string; name?: string } = {},
): Recipe {
  if (typeof raw === 'object' && raw !== null && 'setup' in raw) {
    checkVerbs((raw as { setup: unknown }).setup, 'setup')
  }
  const recipe = validate(makeRecipe(options.finders ?? {}), raw, 'recipe', options.file)
  const name = recipe.name ?? options.name
  if (!name)
    throw new ShotlistError(
      'recipe has no name, and none could be taken from the filename',
      options.file,
    )

  for (const callout of recipe.callouts) {
    if (!(callout.mark in recipe.marks)) {
      const known = Object.keys(recipe.marks)
      throw new ShotlistError(
        `callout points at mark "${callout.mark}", which this recipe does not define` +
          (known.length ? ` — it defines ${known.join(', ')}` : ' — it defines no marks'),
        options.file,
      )
    }
  }
  const numberedMarks = Array.isArray(recipe.numbered)
    ? recipe.numbered
    : (recipe.numbered?.marks ?? [])
  for (const mark of numberedMarks) {
    if (!(mark in recipe.marks)) {
      throw new ShotlistError(
        `numbered lists mark "${mark}", which this recipe does not define`,
        options.file,
      )
    }
  }
  if (recipe.source === 'file' && !recipe.file) {
    throw new ShotlistError('`source: file` needs a `file:` pointing at the PNG', options.file)
  }
  return { ...recipe, name }
}

/** Turn `numbered:` into the callouts it stands for, appended to any written by hand. */
export function withNumbering(recipe: Recipe): Recipe {
  if (!recipe.numbered) return recipe
  const list = Array.isArray(recipe.numbered) ? recipe.numbered : recipe.numbered.marks
  if (!list.length) return recipe
  // `marks` names which marks to number; it is not a callout field, and a strict schema
  // rejects it even set to undefined — so it is dropped rather than blanked.
  const { marks: _named, ...shared } = Array.isArray(recipe.numbered)
    ? { marks: list }
    : recipe.numbered
  const discs = list.map((mark, index) =>
    Callout.parse({ ...shared, mark, n: index + 1, place: 'corner' }),
  )
  return { ...recipe, callouts: [...recipe.callouts, ...discs], numbered: undefined }
}

export interface Library {
  recipes: Map<string, Recipe>
  macros: Map<string, Macro>
  data: Record<string, unknown>
}

const DOCUMENTS = new Set(['.yaml', '.yml', '.json'])

/** Every document in a directory, keyed by filename without its extension. */
function documentsIn(dir: string): Array<{ name: string; file: string; raw: unknown }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => DOCUMENTS.has(extname(entry)) && !entry.startsWith('.'))
    .sort()
    .map((entry) => {
      const file = join(dir, entry)
      return { name: basename(entry, extname(entry)), file, raw: readDocument(file) }
    })
}

/** Load a project's recipes, macros and data from the directories its config names. */
export function loadLibrary(paths: {
  recipes: string
  macros: string
  data: string
  finders?: Record<string, unknown>
}): Library {
  const finders = paths.finders ?? {}

  const macros = new Map<string, Macro>()
  for (const { name, file, raw } of documentsIn(paths.macros)) {
    if (typeof raw === 'object' && raw !== null && 'steps' in raw) {
      checkVerbs((raw as { steps: unknown }).steps, 'steps')
    }
    const macro = validate(makeMacro(finders), raw, 'macro', file)
    macros.set(macro.name ?? name, macro)
  }

  const data: Record<string, unknown> = {}
  for (const { name, raw } of documentsIn(paths.data)) data[name] = raw

  const recipes = new Map<string, Recipe>()
  for (const { name, file, raw } of documentsIn(paths.recipes)) {
    const recipe = withNumbering(parseRecipe(raw, { finders, file, name }))
    recipes.set(recipe.name!, recipe)
  }

  return { recipes, macros, data }
}

export interface ResolvedStep {
  step: StepInput
  /** The variables in scope where this step was written — macro arguments and loop items. */
  vars: Record<string, unknown>
  nested?: ResolvedStep[]
}

/**
 * Flatten `use:` into the macro's own steps, recording each frame's variables.
 *
 * Structure resolves now so an unknown macro fails at load; `$name` stays unresolved
 * because `readValue` can only fill it once the browser is running.
 */
export function expandSteps(
  steps: readonly StepInput[],
  macros: ReadonlyMap<string, Macro>,
  vars: Record<string, unknown> = {},
  seen: readonly string[] = [],
): ResolvedStep[] {
  return steps.flatMap((step): ResolvedStep[] => {
    if (typeof step['use'] === 'string') {
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
      return expandSteps(macro.steps as StepInput[], macros, frame, [...seen, name])
    }

    const nestedKey = Array.isArray(step['steps'])
      ? 'steps'
      : Array.isArray(step['optional'])
        ? 'optional'
        : null
    if (nestedKey) {
      return [
        {
          step,
          vars,
          nested: expandSteps(step[nestedKey] as StepInput[], macros, vars, seen),
        },
      ]
    }
    return [{ step, vars }]
  })
}

/**
 * Resolve `$name` and `${name}` in a value against the variables in scope.
 *
 * `missing` says what to do with a name nothing in scope answers to: a step means it, so
 * it fails; a macro's own arguments are resolved before the scope they will run in exists,
 * so there the name is left as written for the frame below to fill.
 */
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
      throw new ShotlistError(`no value for ${value}`)
    }
    return value.replace(/\$\{?([A-Za-z_][\w.]*)\}?/g, (all, path: string) => {
      const resolved = lookup(vars, path)
      return resolved === undefined ? all : String(resolved)
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

/** Read a dotted path out of the variable scope. */
function lookup(vars: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, vars)
}

export type { QueryInput }
