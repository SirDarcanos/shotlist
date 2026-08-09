/**
 * Check a project's YAML without opening a browser.
 *
 * Shooting stops at the first document it cannot read, which is the right thing when it
 * is about to drive a site — but it makes fixing a shot list a matter of running it,
 * reading one complaint, fixing it, and running it again. This reads everything and
 * reports everything, and needs neither Playwright nor a site that is up.
 */
import { ShotlistError, fromRoot, loadConfig, readDocument } from './config.js'
import type { LoadedConfig } from './config.js'
import { documentFiles, parseMacro, parseRecipe, withNumbering } from './recipe.js'
import type { Recipe } from './recipe.js'

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

/**
 * Every problem in a project's config, macros, data and recipes.
 *
 * A document that fails is recorded and the walk carries on, so one broken file does not
 * hide the other four.
 */
export function lint(configFile?: string, options: { warnings?: boolean } = {}): Problem[] {
  const problems: Problem[] = []
  let loaded: LoadedConfig
  try {
    loaded = loadConfig(configFile)
  } catch (error) {
    const file =
      error instanceof ShotlistError && error.file ? error.file : (configFile ?? 'config')
    return [{ file, message: said(error, file), level: 'error' }]
  }

  const { paths, finders } = loaded.config
  for (const { file } of documentFiles(fromRoot(loaded, paths.macros))) {
    try {
      parseMacro(readDocument(file), { finders, file })
    } catch (error) {
      problems.push({ file, message: said(error, file), level: 'error' })
    }
  }

  // Data files hold whatever a recipe wants to read, so there is no shape to check —
  // only that the document parses at all.
  for (const { file } of documentFiles(fromRoot(loaded, paths.data))) {
    try {
      readDocument(file)
    } catch (error) {
      problems.push({ file, message: said(error, file), level: 'error' })
    }
  }

  for (const { name, file } of documentFiles(fromRoot(loaded, paths.recipes))) {
    try {
      const recipe = withNumbering(parseRecipe(readDocument(file), { finders, file, name }))
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

/** How many documents a lint run looked at, for the line it finishes with. */
export function countDocuments(configFile?: string): number {
  try {
    const loaded = loadConfig(configFile)
    const { paths } = loaded.config
    return (
      1 +
      documentFiles(fromRoot(loaded, paths.macros)).length +
      documentFiles(fromRoot(loaded, paths.data)).length +
      documentFiles(fromRoot(loaded, paths.recipes)).length
    )
  } catch {
    return 1
  }
}
