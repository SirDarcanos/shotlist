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
  })
  .prefault({})

const Viewport = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

const Site = z.object({
  url: z.string(),
  viewport: Viewport.default({ width: 1280, height: 800 }),
  scale: z.number().positive().default(2),
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
  /** A module exporting extra finders, for DOM shapes the query language can't express. */
  findersModule: z.string().optional(),
  check: z
    .object({
      threshold: z.number().min(0).max(1).default(0.002),
    })
    .prefault({}),
})

export type Config = z.infer<typeof Config>
export type Style = z.infer<typeof Style>

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

/** Turn zod's issue list into one line per problem, addressed by its path in the document. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length ? issue.path.join('.') : '(root)'
      return `  ${where}: ${issue.message}`
    })
    .join('\n')
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
