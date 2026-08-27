import { join } from 'node:path'
import { ShotlistError, fromRoot } from './config.js'
import { check, skippedCheckResult } from './check.js'
import type { CheckResult } from './check.js'
import { shoot } from './capture.js'
import type { Retry, ShotResult } from './capture.js'
import { describeEnvironment, environmentDrift, readBaseline, writeBaseline } from './baseline.js'
import type { Drift, Environment } from './baseline.js'
import { loadPlaywright } from './playwright.js'
import type { Browser } from './playwright.js'
import type { Recipe } from './recipe.js'
import { assertRecipe, assertRun } from './run.js'
import type { DeepReadonly, Run } from './run.js'
import { withServer } from './serve.js'

/** Optional behavior shared by capture and checking in one Run. */
interface RunExecutionOptions {
  keepGoing?: boolean
  onRetry?: (retry: Retry) => void
}

/** Optional behavior for checking the selected Recipes in one Run. */
export interface CheckRunOptions extends RunExecutionOptions {
  diff?: boolean
}

/** Structured facts from checking the selected Recipes in one Run. */
export interface CheckRunResult {
  results: readonly CheckResult[]
  drift: readonly Drift[]
}

/** One Recipe that capture could not finish. */
export interface CaptureFailure {
  name: string
  error: unknown
}

/** Optional behavior for capturing the selected Recipes in one Run. */
export interface CaptureRunOptions extends RunExecutionOptions {
  install?: boolean
  onShot?: (shot: ShotResult) => void
  onFailure?: (failure: CaptureFailure) => void
}

/** Structured facts from capturing the selected Recipes in one Run. */
export interface CaptureRunResult {
  shots: readonly ShotResult[]
  failures: readonly CaptureFailure[]
  baselineRecorded: boolean
}

/** Add a cleanup failure without replacing the failure that interrupted the Run. */
function withCleanupFailure(primary: unknown, resource: string, cleanup: unknown): ShotlistError {
  const first = primary instanceof Error ? primary.message : String(primary)
  const second = cleanup instanceof Error ? cleanup.message : String(cleanup)
  return new ShotlistError(`${first}\n  ${resource} cleanup also failed: ${second}`)
}

/** Use one owned browser and always close it without hiding the work's failure. */
async function withBrowser<T>(body: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await loadPlaywright().chromium.launch()
  let result: T | undefined
  let failure: unknown
  let completed = false
  try {
    result = await body(browser)
    completed = true
  } catch (error) {
    failure = error
  }

  try {
    await browser.close()
  } catch (cleanup) {
    if (!completed) throw withCleanupFailure(failure, 'browser', cleanup)
    throw cleanup
  }
  if (!completed) throw failure
  return result!
}

/** Check selected Recipes while owning their shared site and browser lifetimes. */
export async function executeCheckRun(
  run: Run,
  candidates: readonly DeepReadonly<Recipe>[],
  options: CheckRunOptions = {},
): Promise<CheckRunResult> {
  assertRun(run)
  for (const recipe of candidates) assertRecipe(run, recipe)

  const actionable = candidates.filter((recipe) => !skippedCheckResult(run, recipe))
  if (!actionable.length) {
    return {
      results: candidates.map((recipe) => skippedCheckResult(run, recipe)!),
      drift: [],
    }
  }

  /** Check through one browser while the actionable Application Recipes can reach the site. */
  const work = () =>
    withBrowser(async (browser): Promise<CheckRunResult> => {
      const drift = environmentDrift(readBaseline(run), describeEnvironment(browser))
      const results = await check(run, candidates, {
        browser,
        keepGoing: options.keepGoing,
        onRetry: options.onRetry,
        ...(options.diff
          ? { diffDir: join(fromRoot(run.project, run.project.config.paths.out), 'diff') }
          : {}),
      })
      return { results, drift }
    })

  return actionable.some((recipe) => recipe.source === 'app')
    ? await withServer(run, work)
    : await work()
}

/** Capture selected Recipes while owning their shared site and browser lifetimes. */
export async function executeCaptureRun(
  run: Run,
  candidates: readonly DeepReadonly<Recipe>[],
  options: CaptureRunOptions = {},
): Promise<CaptureRunResult> {
  assertRun(run)
  for (const recipe of candidates) assertRecipe(run, recipe)

  let environment: Environment | undefined
  /** Capture sequentially through one browser while Application Recipes can reach the site. */
  const work = () =>
    withBrowser(async (browser): Promise<Omit<CaptureRunResult, 'baselineRecorded'>> => {
      environment = describeEnvironment(browser)
      const shots: ShotResult[] = []
      const failures: CaptureFailure[] = []
      for (const recipe of candidates) {
        try {
          const shot = await shoot(run, recipe, {
            install: options.install,
            browser,
            onRetry: options.onRetry,
          })
          shots.push(shot)
          options.onShot?.(shot)
        } catch (error) {
          if (!options.keepGoing) throw error
          const failure = { name: recipe.name!, error }
          failures.push(failure)
          options.onFailure?.(failure)
        }
      }
      return { shots, failures }
    })

  const captured = candidates.some((recipe) => recipe.source === 'app')
    ? await withServer(run, work)
    : await work()
  const baselineRecorded = Boolean(options.install && !captured.failures.length)
  if (baselineRecorded) writeBaseline(run, environment!)
  return { ...captured, baselineRecorded }
}
