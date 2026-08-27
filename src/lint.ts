/**
 * Check a project's YAML without opening a browser.
 *
 * Shooting stops at the first document it cannot read, which is the right thing when it
 * is about to drive a site — but it makes fixing a shot list a matter of running it,
 * reading one complaint, fixing it, and running it again. This reads everything and
 * reports everything, and needs neither Playwright nor a site that is up.
 */
import { basename, join } from 'node:path'
import { ShotlistError, fromRoot, loadConfig, readDocument, readDocumentAt } from './config.js'
import type { LoadedConfig } from './config.js'
import { documentFiles, parseMacro, parseRecipe, withNumbering } from './recipe.js'
import type { Recipe } from './recipe.js'
import { projectPolicy } from './run.js'
import type { OperatorAuthority } from './run.js'
import { authorizePath } from './trust.js'
import type { Trust } from './trust.js'

/** One thing wrong, addressed by the file it is in. */
export interface Problem {
  file: string
  message: string
  /** An error is the schema refusing the document; a warning is legal but probably not meant. */
  level: 'error' | 'warning'
}

/**
 * What a thrown failure says, without what the report is already showing.
 *
 * The filename heads the group, and `invalid recipe —` says only what the directory it
 * was found in said first.
 */
function said(error: unknown, file: string): string {
  const message = error instanceof ShotlistError ? error.message : String(error)
  const withoutFile = message.startsWith(`${file}: `) ? message.slice(file.length + 2) : message
  return withoutFile.replace(/^invalid (?:recipe|macro|config) —\n\s*/, '')
}

/** Legal, but almost certainly not what the author meant. */
function suspect(recipe: Recipe, loaded: LoadedConfig): string[] {
  const found: string[] = []
  const pointedAt = new Set(recipe.callouts.map((callout) => callout.mark))
  for (const name of Object.keys(recipe.marks)) {
    if (!pointedAt.has(name)) found.push(`mark "${name}" is never used by a callout`)
  }
  for (const callout of recipe.callouts) {
    if (!(callout.mark in recipe.marks)) {
      found.push(`callout points at "${callout.mark}", which no mark defines`)
    }
  }
  if (recipe.install !== undefined && !(recipe.install in loaded.config.install)) {
    found.push(`install: "${recipe.install}" is not a destination the config names`)
  }
  if (recipe.session !== undefined && !(recipe.session in loaded.config.site.sessions)) {
    found.push(`session: "${recipe.session}" is not a session the config names`)
  }
  return found
}

export interface LintOptions {
  warnings?: boolean
}

type LibraryKind = 'macros' | 'data' | 'recipes'

/** Read a document through policy while retaining its authored path in diagnostics. */
function lintDocument(
  trust: Trust | undefined,
  target: string,
  file: string,
  where: string,
): unknown {
  if (!trust) return readDocument(file)
  return readDocumentAt(authorizePath(trust, target, where), file)
}

/** Every problem in a Project's config, macros, data and Recipes. */
export function lint(
  authority: OperatorAuthority,
  configFile?: string,
  options?: LintOptions,
): Problem[]
/** Compatibility interface for callers migrating to explicit Operator authority. */
export function lint(configFile?: string, options?: LintOptions): Problem[]
/** Accumulate malformed and unauthorized documents without requiring a complete Run. */
export function lint(
  input?: OperatorAuthority | string,
  configOrOptions?: string | LintOptions,
  authorityOptions: LintOptions = {},
): Problem[] {
  const usesAuthority = input !== undefined && typeof input !== 'string'
  const configFile = usesAuthority
    ? typeof configOrOptions === 'string'
      ? configOrOptions
      : undefined
    : input
  const options = usesAuthority
    ? typeof configOrOptions === 'object' && configOrOptions !== null
      ? configOrOptions
      : authorityOptions
    : ((configOrOptions ?? {}) as LintOptions)
  const problems: Problem[] = []
  let loaded: LoadedConfig
  try {
    loaded = loadConfig(configFile)
  } catch (error) {
    const file =
      error instanceof ShotlistError && error.file ? error.file : (configFile ?? 'config')
    return [{ file, message: said(error, file), level: 'error' }]
  }

  let trust: Trust | undefined
  if (usesAuthority) {
    try {
      trust = projectPolicy(input as OperatorAuthority, loaded).trust
    } catch (error) {
      return [{ file: loaded.file, message: said(error, loaded.file), level: 'error' }]
    }
  }

  const { paths, finders } = loaded.config
  const documents = (kind: LibraryKind): Array<{ name: string; file: string; target: string }> => {
    const authored = fromRoot(loaded, paths[kind])
    let directory = authored
    try {
      if (trust) directory = authorizePath(trust, authored, `paths.${kind}`)
      return documentFiles(directory).map(({ name, file: target }) => ({
        name,
        file: join(authored, basename(target)),
        target,
      }))
    } catch (error) {
      problems.push({ file: authored, message: said(error, authored), level: 'error' })
      return []
    }
  }

  for (const { file, target } of documents('macros')) {
    try {
      parseMacro(lintDocument(trust, target, file, 'paths.macros'), { finders, file })
    } catch (error) {
      problems.push({ file, message: said(error, file), level: 'error' })
    }
  }

  // Data files hold whatever a Recipe wants to read, so there is no shape to check —
  // only that the document parses at all.
  for (const { file, target } of documents('data')) {
    try {
      lintDocument(trust, target, file, 'paths.data')
    } catch (error) {
      problems.push({ file, message: said(error, file), level: 'error' })
    }
  }

  for (const { name, file, target } of documents('recipes')) {
    try {
      const recipe = withNumbering(
        parseRecipe(lintDocument(trust, target, file, 'paths.recipes'), {
          finders,
          file,
          name,
        }),
      )
      if (options.warnings) {
        for (const message of suspect(recipe, loaded)) {
          problems.push({ file, message, level: 'warning' })
        }
      }
    } catch (error) {
      problems.push({ file, message: said(error, file), level: 'error' })
    }
  }
  return problems
}

/** The report, grouped by file, with a count that says whether anything has to be fixed. */
export function formatProblems(problems: readonly Problem[], checked: number): string[] {
  if (!problems.length) {
    return [`nothing wrong in ${checked} file${checked === 1 ? '' : 's'}`]
  }
  const lines: string[] = []
  for (const file of [...new Set(problems.map((one) => one.file))]) {
    lines.push(file)
    for (const problem of problems.filter((one) => one.file === file)) {
      const mark = problem.level === 'warning' ? '!' : '✗'
      lines.push(`  ${mark} ${problem.message.replace(/\n/g, '\n  ')}`)
    }
  }
  const errors = problems.filter((one) => one.level === 'error').length
  const warnings = problems.length - errors
  const counted = [
    `${errors} error${errors === 1 ? '' : 's'}`,
    ...(warnings ? [`${warnings} warning${warnings === 1 ? '' : 's'}`] : []),
  ]
  lines.push('', `${counted.join(', ')} in ${checked} file${checked === 1 ? '' : 's'}`)
  return lines
}

/** Count documents reachable under explicit Operator authority. */
export function countDocuments(authority: OperatorAuthority, configFile?: string): number
/** Compatibility interface for callers migrating to explicit Operator authority. */
export function countDocuments(configFile?: string): number
/** How many documents a lint run looked at, for the line it finishes with. */
export function countDocuments(input?: OperatorAuthority | string, authorityFile?: string): number {
  const usesAuthority = input !== undefined && typeof input !== 'string'
  const configFile = usesAuthority ? authorityFile : input
  try {
    const loaded = loadConfig(configFile)
    const trust = usesAuthority
      ? projectPolicy(input as OperatorAuthority, loaded).trust
      : undefined
    const { paths } = loaded.config
    return (
      1 +
      (['macros', 'data', 'recipes'] as const).reduce((total, kind) => {
        const authored = fromRoot(loaded, paths[kind])
        try {
          const directory = trust ? authorizePath(trust, authored, `paths.${kind}`) : authored
          return total + documentFiles(directory).length
        } catch {
          return total
        }
      }, 0)
    )
  } catch {
    return 1
  }
}
