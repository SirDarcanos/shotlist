import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

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
         * Held to a URL because it is put into the drawing page's markup: a value with a
         * quote in it used to close the attribute and open a script tag.
         */
        fontUrl: z
          .string()
          .refine(
            (value) => {
              try {
                return ['http:', 'https:', 'data:', 'file:'].includes(new URL(value).protocol)
              } catch {
                return false
              }
            },
            { message: 'must be a http(s), data: or file: URL' },
          )
          .optional(),
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
     * What a masked region is painted with. Neutral rather than the callout colour: a
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

const Site = z.object({
  url: z.string(),
  /** Started before the first shot and stopped after the last, unless already running. */
  serve: Serve.optional(),
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

export const Config = z.object({
  site: Site,
  style: Style,
  paths: z
    .object({
      recipes: z.string().default('screenshots/recipes'),
      macros: z.string().default('screenshots/macros'),
      data: z.string().default('screenshots/data'),
      out: z.string().default('screenshots/out'),
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
   * Honoured whether the config is trusted or not, because it can only ever refuse more.
   */
  deny: z.array(z.string()).default([]),
  check: z
    .object({
      /** The fraction of differing pixels a shot may have before it counts as changed. */
      threshold: z.number().min(0).max(1).default(0.002),
      /** How far one channel may move before a pixel counts as differing, out of 255. */
      tolerance: z.number().min(0).max(255).default(8),
    })
    .prefault({}),
})

export type Config = z.infer<typeof Config>
export type Style = z.infer<typeof Style>
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
function explain(issues: readonly Issue[], prefix: PropertyKey[] = [], depth = 0): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path]
    if (issue.code === 'invalid_union' && depth < UNION_DEPTH) {
      const branches = issue.errors.filter(
        (branch) => !branch.every((each) => each.code === 'invalid_type' && !each.path.length),
      )
      if (branches.length) {
        return [...new Set(branches.flatMap((branch) => explain(branch, path, depth + 1)))]
      }
    }
    const where = path.length ? path.join('.') : '(root)'
    return [`  ${where}: ${issue.message}`]
  })
}

/** Turn zod's issue list into one line per problem, addressed by its path in the document. */
export function formatIssues(error: z.ZodError): string {
  return explain(error.issues).join('\n')
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
    throw new ShotlistError(`invalid config —\n${formatIssues(result.error)}`, file)
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
