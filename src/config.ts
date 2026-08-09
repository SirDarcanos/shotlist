import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { FORMATS } from './image.js'
import { QUERY_KEYS } from './query.js'

const Style = z
  .object({
    color: z.string().default('#DC2626'),
    canvas: z.string().default('#FFFFFF'),
    box: z
      .object({
        width: z.number().default(6),
        radius: z.number().default(10),
        pad: z.number().default(8),
      })
      .prefault({}),
    arrow: z
      .object({
        shaft: z.number().default(6),
        headHalf: z.number().default(19),
        headLength: z.number().default(38),
      })
      .prefault({}),
    label: z
      .object({
        font: z.string().default('Arial, Helvetica, sans-serif'),
        weight: z.union([z.number(), z.string()]).default(700),
        size: z.number().default(44),
        fill: z.string().default('#FFFFFF'),
        stroke: z.string().optional(),
        strokeWidth: z.number().default(6),
        gap: z.number().default(40),
        /**
         * A stylesheet to load before drawing — a Google Fonts URL, or any @font-face
         * sheet. Without it a family has to be installed on the machine that shoots.
         * Needs network access at shoot time.
         *
         * A http(s) or `data:` URL is linked and fetched. Anything else is a path — read
         * from disk and inlined, along with the font files it points at, because the
         * drawing page is built with `setContent` and a browser will not give a page
         * with no file origin a `file:` subresource.
         */
        fontUrl: z.string().optional(),
      })
      .prefault({}),
    number: z
      .object({
        radius: z.number().default(26),
        size: z.number().default(40),
        fill: z.string().optional(),
        text: z.string().default('#FFFFFF'),
      })
      .prefault({}),
    /**
     * What a masked region is painted with. Neutral rather than the callout color: a
     * mask is not pointing anything out, and a white one would vanish on a light UI.
     */
    mask: z.object({ fill: z.string().default('#94A3B8') }).prefault({}),
  })
  .prefault({})

/** What a browser can actually paint; past it the tab dies rather than reporting. */
export const MAX_PIXELS = 16384

const Viewport = z.object({
  width: z.number().int().positive().max(MAX_PIXELS),
  height: z.number().int().positive().max(MAX_PIXELS),
})

/** How to start the site, for a run that cannot assume somebody already has. */
const ServeOptions = z
  .object({
    /**
     * Run directly, without a shell: `npm run dev`, not `PORT=3000 npm run dev && …`.
     * Environment goes under `env`, and anything needing a shell goes in a script.
     */
    command: z.string(),
    /**
     * What proves it is up: a http(s) URL to fetch, a port to connect to, or a pattern
     * to wait for in its output. Defaults to fetching `site.url`.
     */
    ready: z
      .union([z.string(), z.int().positive(), z.object({ log: z.string() }).strict()])
      .optional(),
    /** Where to run it. A relative path resolves from the config file's directory. */
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    timeout: z.number().positive().default(30000),
  })
  .strict()

/** `serve: npm run dev` is the whole of it for most projects; the mapping is the rest. */
const Serve = z.union([
  z.string().transform((command) => ServeOptions.parse({ command })),
  ServeOptions,
])

const SessionOptions = z
  .object({
    /** Where the state is kept, from the config's directory. Holds cookies: do not commit. */
    path: z.string(),
    /**
     * A selector only a signed-in page has. Without one an expired session redirects
     * rather than failing, and every shot of the run becomes the sign-in form.
     */
    verify: z.string().optional(),
  })
  .strict()

/** `admin: .shotlist/admin.json` is the whole of it; the mapping adds `verify`. */
const Session = z.union([
  z.string().transform((path) => SessionOptions.parse({ path })),
  SessionOptions,
])

const Site = z.strictObject({
  url: z.string(),
  /** Started before the first shot and stopped after the last, unless already running. */
  serve: Serve.optional(),
  /** Signed-in states by name, written by `--login <name>` and picked by a recipe's `session:`. */
  sessions: z.record(z.string(), Session).default({}),
  /**
   * Hosts a shot may open besides this site's own and everything under it — a sign-in
   * provider a flow passes through, a docs domain, a third-party page worth shooting.
   * Ignored by an `--untrusted` run, which is what makes that flag worth having.
   */
  allow: z.array(z.string()).default([]),
  viewport: Viewport.default({ width: 1280, height: 800 }),
  scale: z.number().positive().max(64).default(2),
  theme: z.enum(['light', 'dark', 'no-preference']).default('light'),
  reducedMotion: z.boolean().default(true),
  /** A selector proving the app has booted — waited for after every navigation. */
  ready: z.string().optional(),
  /** Milliseconds to settle after `ready`, for the fetches a selector cannot see. */
  settle: z.number().nonnegative().default(0),
  timeout: z.number().positive().default(15000),
})

export const Config = z.strictObject({
  site: Site,
  style: Style,
  paths: z
    .strictObject({
      recipes: z.string().default('screenshots/recipes'),
      macros: z.string().default('screenshots/macros'),
      data: z.string().default('screenshots/data'),
      out: z.string().default('screenshots/out'),
    })
    .prefault({}),
  /**
   * What images are written as. `png` keeps every pixel; `webp` is a good deal smaller
   * for the same thing and is what a browser will be showing them in anyway. `jpeg` is
   * lossy in the way that shows worst on the thing a UI screenshot is mostly made of,
   * which is text.
   *
   * AVIF is not here: the encoder is a browser, and Chromium reads AVIF but will not
   * write it.
   */
  image: z
    .strictObject({
      format: z.enum(FORMATS).default('png'),
      /** Ignored by `png`, which has nothing to trade. */
      quality: z.int().min(1).max(100).default(90),
    })
    .prefault({}),
  /** Named install destinations a recipe selects with `install: <name>`. */
  install: z.record(z.string(), z.string()).default({}),
  /** Project-defined query aliases: `trackerRow: { css: …, contains: $1 }`. */
  finders: z.record(z.string(), z.unknown()).default({}),
  /**
   * Names this project will not have read or written, on top of the ones shotlist never
   * touches. One path segment each, with `*` for any run of characters — so `*.sqlite`
   * is a file and `fixtures` is a folder and everything under it.
   *
   * Honored whether the config is trusted or not, because it can only ever refuse more.
   */
  deny: z.array(z.string()).default([]),
  check: z
    .strictObject({
      /** The fraction of differing pixels a shot may have before it counts as changed. */
      threshold: z.number().min(0).max(1).default(0.002),
      /** How far one channel may move before a pixel counts as differing, out of 255. */
      tolerance: z.number().min(0).max(255).default(8),
    })
    .prefault({}),
})

export type Config = z.infer<typeof Config>
export type Style = z.infer<typeof Style>

/**
 * Every key name anywhere in a schema, for suggesting the one an author meant.
 *
 * Walked rather than listed, so a key added three levels down is offered the day it
 * exists. Zod's internals are read defensively: a shape this does not recognize costs a
 * suggestion, never a crash, and the depth cap stops a recursive schema walking forever.
 */
export function keysIn(schema: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 8 || seen.has(schema)) return []
  seen.add(schema)
  const def = (schema as { def?: Record<string, unknown> })?.def
  if (!def) return []
  const found: string[] = []
  const shape = def['shape'] as Record<string, unknown> | undefined
  if (shape) {
    found.push(...Object.keys(shape))
    for (const inner of Object.values(shape)) found.push(...keysIn(inner, depth + 1, seen))
  }
  for (const key of ['innerType', 'element', 'valueType']) {
    if (def[key]) found.push(...keysIn(def[key], depth + 1, seen))
  }
  const options = def['options'] as unknown[] | undefined
  if (Array.isArray(options)) {
    for (const option of options) found.push(...keysIn(option, depth + 1, seen))
  }
  return found
}

/** Every name a config may legally use as a key. `finders` hold queries, so those too. */
const CONFIG_WORDS: readonly string[] = [...new Set([...keysIn(Config), ...QUERY_KEYS])]
export type Serve = z.infer<typeof Serve>

const FILENAMES = ['shotlist.config.yaml', 'shotlist.config.yml', 'shotlist.config.json']

/** Walk up from `from` until a config file turns up, or return null at the filesystem root. */
export function findConfig(from: string = process.cwd()): string | null {
  let dir = resolve(from)
  for (;;) {
    for (const name of FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** A validation failure an author can act on: the file, the path in it, and what was wrong. */
export class ShotlistError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message)
    this.name = 'ShotlistError'
  }
}

type Issue = z.ZodError['issues'][number]

/** How far into nested unions to follow a failure before taking zod's own summary. */
const UNION_DEPTH = 3

/**
 * One line per problem, following a union into the branch the author plainly meant.
 *
 * A union reports `Invalid input` and nothing else, which for `serve`, `clip`, `numbered`
 * or `check` names neither the key that was wrong nor what it should have been. A branch
 * that failed only because the value is the wrong type entirely is not the one being
 * written — `serve: { command: …, reddy: … }` is not a failed attempt at a string.
 * Whatever branches are left are the ones with something to say.
 */
/** How many of an author's keys a branch did not know. */
function unknownIn(branch: readonly Issue[]): number {
  return branch.reduce(
    (total, issue) => total + (issue.code === 'unrecognized_keys' ? issue.keys.length : 0),
    0,
  )
}

/**
 * Edit distance, for suggesting the word an author meant.
 *
 * Shared by the step verbs and the key names: a typo is a typo wherever it lands.
 */
export function distance(a: string, b: string): number {
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

/** The name a misspelling was reaching for, or undefined when nothing is close enough. */
export function nearest(word: string, known: readonly string[]): string | undefined {
  let best: string | undefined
  let score = Infinity
  for (const candidate of known) {
    const d = distance(word.toLowerCase(), candidate.toLowerCase())
    if (d < score) {
      score = d
      best = candidate
    }
  }
  return best !== undefined && score <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined
}

function explain(
  issues: readonly Issue[],
  prefix: PropertyKey[] = [],
  depth = 0,
  known: readonly string[] = [],
): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path]
    if (issue.code === 'invalid_union' && depth < UNION_DEPTH) {
      // A branch that rejected the value without looking inside it is not the one being
      // written: `clip: { css: … }` is not a failed attempt at the word `viewport`.
      const branches = issue.errors.filter(
        (branch) =>
          !branch.every(
            (each) =>
              (each.code === 'invalid_type' || each.code === 'invalid_value') && !each.path.length,
          ),
      )
      // Of what is left, a branch complaining only about extra keys knew everything else
      // that was written — and the one that knew most of it names the fewest.
      const shapely = branches.filter((branch) =>
        branch.every((each) => each.code === 'unrecognized_keys'),
      )
      const chosen = shapely.length
        ? [shapely.reduce((best, branch) => (unknownIn(branch) < unknownIn(best) ? branch : best))]
        : branches
      if (chosen.length) {
        return [...new Set(chosen.flatMap((branch) => explain(branch, path, depth + 1, known)))]
      }
    }
    const where = path.length ? path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => {
        const meant = nearest(key, known)
        return `  ${where}: unknown key "${key}"${meant ? ` — did you mean "${meant}"?` : ''}`
      })
    }
    return [`  ${where}: ${issue.message}`]
  })
}

/**
 * Turn zod's issue list into one line per problem, addressed by its path in the document.
 *
 * `known` is every name a suggestion may propose. Passed in rather than read off the
 * schema, because zod reports which key it did not recognize and never which it would.
 */
export function formatIssues(error: z.ZodError, known: readonly string[] = []): string {
  return explain(error.issues, [], 0, known).join('\n')
}

/**
 * The page's own complaint, without Playwright's call prefix or the in-page stack.
 *
 * A query is resolved by a function serialized into the browser, so a failure arrives
 * wrapped: `page.evaluateHandle: Error: no element matched {…}` followed by a JavaScript
 * stack through `UtilityScript`. The person reading it is editing YAML, and none of that
 * is about their recipe.
 */
export function pageMessage(error: unknown): string {
  const [first = ''] = String((error as Error | undefined)?.message ?? error).split('\n')
  return first.replace(/^page\.\w+:\s*/, '').replace(/^Error:\s*/, '')
}

/** Parse a YAML or JSON document, reporting the file and the parser's own line and column. */
export function readDocument(file: string): unknown {
  const text = readFileSync(file, 'utf8')
  try {
    return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
  } catch (error) {
    throw new ShotlistError((error as Error).message, file)
  }
}

/** Validate a raw config object, filling every default. */
export function parseConfig(raw: unknown, file?: string): Config {
  const result = Config.safeParse(raw)
  if (!result.success) {
    throw new ShotlistError(`invalid config —\n${formatIssues(result.error, CONFIG_WORDS)}`, file)
  }
  return result.data
}

export interface LoadedConfig {
  config: Config
  /** The config file's own directory: every path in `paths` and `install` resolves from here. */
  root: string
  file: string
  /**
   * What this config is allowed to do to the machine running it, set by the operator.
   * Absent means the config is the operator's own, which is what a desk looks like.
   */
  trust?: import('./trust.js').Trust
}

/** Load the nearest config file, or the one given, with its root directory. */
export function loadConfig(file?: string): LoadedConfig {
  const found = file ? resolve(file) : findConfig()
  if (!found) {
    throw new ShotlistError(
      `no config found — create shotlist.config.yaml, or pass --config <file>`,
    )
  }
  if (!existsSync(found)) throw new ShotlistError('config file does not exist', found)
  return { config: parseConfig(readDocument(found), found), root: dirname(found), file: found }
}

/** Resolve a config-relative path against the config file's directory. */
export function fromRoot(loaded: Pick<LoadedConfig, 'root'>, path: string): string {
  return isAbsolute(path) ? path : join(loaded.root, path)
}

/** The style a recipe draws with: the project's, with the recipe's own overrides on top. */
export function mergeStyle(base: Style, override?: DeepPartial<Style>): Style {
  if (!override) return base
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const current = (base as Record<string, unknown>)[key]
    merged[key] =
      typeof value === 'object' && value !== null && typeof current === 'object' && current !== null
        ? { ...(current as object), ...(value as object) }
        : value
  }
  return merged as Style
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
