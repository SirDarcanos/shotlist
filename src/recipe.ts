import { z } from 'zod'
import { MAX_PIXELS, ShotlistError, formatIssues, keysIn } from './config.js'
import { FORMATS } from './image.js'
import { authoredWork, validateMatchingIn } from './work-limit.js'
import type { WorkLimits } from './work-limit.js'
import { QUERY_KEYS, makeQuery } from './query.js'
import {
  ENV,
  VERBS,
  checkStepVerbs,
  expandSteps,
  interpolate,
  makeStep,
  nearestVerb,
} from './step.js'
import type { QueryInput } from './query.js'
import type { ResolvedStep, StepInput } from './step.js'

export { ENV, VERBS, expandSteps, interpolate, nearestVerb }
export type { ResolvedStep, StepInput }

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

/** The Recipe schema, bound to a Project's Finders. */
export function makeRecipe(aliases: Readonly<Record<string, unknown>> = {}) {
  const Query = makeQuery(aliases)
  return z
    .object({
      /** A filename, not a path: it names the image written into `paths.out`. */
      name: z
        .string()
        .refine((value) => !/[\\/]|^\.\.?$/.test(value), {
          message: 'is the name of an image, so it cannot contain a path',
        })
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
          message: 'is a filename, so it cannot hold control characters',
        })
        .optional(),
      source: z.enum(['app', 'file']).default('app'),
      /** With `source: file`, the image to annotate instead of driving the site. */
      file: z.string().optional(),
      install: z.string().optional(),
      /** Which of `site.sessions` to shoot this as. Unset, the browser is a stranger. */
      session: z.string().optional(),
      url: z.string().optional(),
      viewport: z
        .object({
          width: z.number().int().positive().max(MAX_PIXELS),
          height: z.number().int().positive().max(MAX_PIXELS),
        })
        .optional(),
      scale: z.number().positive().max(64).optional(),
      /** What this shot is written as, when it differs from the project's. */
      format: z.enum(FORMATS).optional(),
      quality: z.int().min(1).max(100).optional(),
      theme: z.enum(['light', 'dark', 'no-preference']).optional(),
      style: StylePatch.optional(),
      setup: z.array(makeStep(aliases)).default([]),
      /**
       * Steps run after the shot, and after a shot that failed.
       *
       * Closing the browser undoes the browser, and nothing `setup` asked the application
       * to do: a recipe that has to create an order to photograph one leaves an order
       * behind, and the next run finds two. What a teardown throws is reported only when
       * the shot itself came back — the reason a shot failed is worth more than the
       * trouble tidying up after it had.
       */
      teardown: z.array(makeStep(aliases)).default([]),
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

/** The Macro schema, bound to a Project's Finders. */
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

/**
 * Every name a recipe may legally use as a key, for suggesting the one that was meant.
 *
 * Read off the schemas rather than listed, so a new verb or query primitive is offered
 * as a suggestion the day it is added.
 */
const RECIPE_WORDS: readonly string[] = [...new Set([...keysIn(Recipe), ...QUERY_KEYS, ...VERBS])]

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
    throw new ShotlistError(`invalid ${what} —\n${formatIssues(result.error, RECIPE_WORDS)}`, file)
  }
  return result.data
}

/** Keys a recipe has and a macro does not, for telling one filed as the other apart. */
const RECIPE_ONLY: ReadonlySet<string> = new Set(
  Object.keys(Recipe.shape).filter((key) => !['name', 'defaults', 'steps'].includes(key)),
)

/**
 * Refuse a document that is plainly the other kind, and say which.
 *
 * A recipe in `paths.macros` fails as a macro missing `steps`, followed by a line for
 * every recipe key it has — which describes the symptom eight times and never once names
 * the cause, that the file is in the wrong directory.
 */
function checkKind(raw: unknown, kind: 'recipe' | 'macro', file?: string): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const keys = Object.keys(raw)
  if (kind === 'macro' && !keys.includes('steps')) {
    const recipeish = keys.filter((key) => RECIPE_ONLY.has(key))
    if (recipeish.length) {
      throw new ShotlistError(
        `this reads as a recipe rather than a macro — it has ${recipeish.join(', ')}, and a ` +
          'macro is `steps:` with an optional `name` and `defaults`. Move it to ' +
          '`paths.recipes`, or give it the steps it is missing.',
        file,
      )
    }
  }
  if (kind === 'recipe' && keys.includes('steps') && !keys.includes('setup')) {
    throw new ShotlistError(
      'this reads as a macro rather than a recipe — a recipe drives the page with ' +
        '`setup:` and says what to shoot. Move it to `paths.macros`, or rename `steps` ' +
        'to `setup`.',
      file,
    )
  }
}

/** Validate one macro document, checking its verbs the way a recipe's setup is checked. */
export function parseMacro(
  raw: unknown,
  options: {
    finders?: Readonly<Record<string, unknown>>
    file?: string
    workLimits?: Pick<WorkLimits, 'authoredSteps' | 'stepDepth' | 'matchingCharacters'>
  } = {},
): Macro {
  checkKind(raw, 'macro', options.file)
  authoredWork(raw, ['steps'], options.workLimits, options.file)
  if (typeof raw === 'object' && raw !== null && 'steps' in raw) {
    checkStepVerbs((raw as { steps: unknown }).steps, 'steps')
  }
  const macro = validate(makeMacro(options.finders ?? {}), raw, 'macro', options.file)
  try {
    validateMatchingIn(macro, options.workLimits?.matchingCharacters)
  } catch (error) {
    throw new ShotlistError((error as Error).message, options.file)
  }
  return macro
}

/** Validate one recipe document against this project's aliases. */
export function parseRecipe(
  raw: unknown,
  options: {
    finders?: Readonly<Record<string, unknown>>
    file?: string
    name?: string
    workLimits?: Pick<WorkLimits, 'authoredSteps' | 'stepDepth' | 'matchingCharacters'>
  } = {},
): Recipe {
  checkKind(raw, 'recipe', options.file)
  authoredWork(raw, ['setup', 'teardown'], options.workLimits, options.file)
  for (const key of ['setup', 'teardown'] as const) {
    if (typeof raw === 'object' && raw !== null && key in raw) {
      checkStepVerbs((raw as Record<string, unknown>)[key], key)
    }
  }
  const recipe = validate(makeRecipe(options.finders ?? {}), raw, 'recipe', options.file)
  try {
    validateMatchingIn(recipe, options.workLimits?.matchingCharacters)
  } catch (error) {
    throw new ShotlistError((error as Error).message, options.file)
  }
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
    throw new ShotlistError('`source: file` needs a `file:` pointing at an image', options.file)
  }
  // Refused rather than ignored: there is no page for them to run against, so a recipe
  // carrying them is one whose author believes something is happening that is not.
  const unrun = (['setup', 'teardown'] as const).filter(
    (key) => recipe.source === 'file' && recipe[key].length,
  )
  if (unrun.length) {
    throw new ShotlistError(
      `${unrun.join(' and ')}: \`source: file\` annotates an image on disk and never opens a ` +
        'page, so these steps would never run — drop them, or drop `source: file`',
      options.file,
    )
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

export type { QueryInput }
