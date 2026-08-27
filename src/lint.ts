/**
 * Check a project's YAML without opening a browser.
 *
 * Shooting stops at the first document it cannot read, which is the right thing when it
 * is about to drive a site — but it makes fixing a shot list a matter of running it,
 * reading one complaint, fixing it, and running it again. This reads everything and
 * reports everything, and needs neither Playwright nor a site that is up.
 */
import { ShotlistError, loadConfig } from './config.js'
import { countLibraryDocuments, reviewLibrary } from './library.js'
import type { LibraryProblem, LibraryReviewOptions } from './library.js'
import { operatorAuthority, projectPolicy } from './run.js'
import type { OperatorAuthority } from './run.js'

export type Problem = LibraryProblem
export type LintOptions = LibraryReviewOptions

/** Problems and file count observed by one lint traversal. */
export interface LintReport {
  readonly problems: readonly Problem[]
  readonly checked: number
}

/** What a thrown config failure says without the filename the report already carries. */
function said(error: unknown, file: string): string {
  const message = error instanceof ShotlistError ? error.message : String(error)
  const withoutFile = message.startsWith(`${file}: `) ? message.slice(file.length + 2) : message
  return withoutFile.replace(/^invalid config —\n\s*/, '')
}

/** Review a Project once, retaining its problems and exact file count together. */
export function reviewProject(
  authorityValue: OperatorAuthority,
  configFile?: string,
  options: LintOptions = {},
): LintReport {
  const authority = operatorAuthority(authorityValue)
  let loaded
  try {
    loaded = loadConfig(configFile)
  } catch (error) {
    const file =
      error instanceof ShotlistError && error.file ? error.file : (configFile ?? 'config')
    return Object.freeze({
      problems: Object.freeze([{ file, message: said(error, file), level: 'error' as const }]),
      checked: 1,
    })
  }
  const trust = projectPolicy(authority, loaded).trust
  const review = reviewLibrary(loaded, trust, options)
  return Object.freeze({ problems: review.problems, checked: 1 + review.documents })
}

/** Accumulate malformed and unauthorized documents without requiring a complete Run. */
export function lint(
  authorityValue: OperatorAuthority,
  configFile?: string,
  options: LintOptions = {},
): Problem[] {
  return [...reviewProject(authorityValue, configFile, options).problems]
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

/** Count the Project config and discovered Library documents without reading them. */
export function countDocuments(authorityValue: OperatorAuthority, configFile?: string): number {
  const authority = operatorAuthority(authorityValue)
  try {
    const loaded = loadConfig(configFile)
    const trust = projectPolicy(authority, loaded).trust
    return 1 + countLibraryDocuments(loaded, trust)
  } catch {
    return 1
  }
}
