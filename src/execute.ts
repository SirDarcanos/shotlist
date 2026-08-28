import { join } from 'node:path'
import { ShotlistError, fromRoot } from './config.js'
import { check, skippedCheckResult } from './check.js'
import type { CheckResult } from './check.js'
import { captureCleanupFailures, shoot } from './capture.js'
import type { Retry, ShotResult } from './capture.js'
import { describeEnvironment, environmentDrift, readBaseline, writeBaseline } from './baseline.js'
import type { Drift, Environment } from './baseline.js'
import { loadPlaywright } from './playwright.js'
import type { Browser } from './playwright.js'
import type { Recipe } from './recipe.js'
import { assertRecipe, assertRun } from './run.js'
import type { DeepReadonly, Run } from './run.js'
import type { NetworkDestination } from './network-policy.js'
import { startServer, withServer } from './serve.js'
import { RequestCancelledError } from './work-limit.js'

/** Select named Recipes in caller order or every Recipe in deterministic name order. */
export type CaptureSelection =
  | { readonly recipes: readonly string[]; readonly all?: never }
  | { readonly all: true; readonly recipes?: never }

/** Observe ordered facts from one Run request. */
export type RunProgressObserver = (progress: RunProgress) => unknown | Promise<unknown>

/** Options shared by Capture and Checking requests. */
interface RunRequestOptions {
  readonly keepGoing?: boolean
  readonly signal?: AbortSignal
  readonly onProgress?: RunProgressObserver
}

/** One request to Capture through an authentic Run. */
export type CaptureRequest = CaptureSelection & RunRequestOptions

/** Select Recipes for Checking with the same guarantees as Capture selection. */
export type CheckSelection = CaptureSelection

/** One request to perform Checking through an authentic Run. */
export type CheckRequest = CheckSelection &
  RunRequestOptions & {
    readonly diff?: boolean
  }

/** One selected Recipe that produced an Output image. */
export interface CapturedRecipeResult {
  readonly name: string
  readonly status: 'captured'
  readonly shot: Readonly<ShotResult>
}

/** One selected Recipe whose Capture failed. */
export interface FailedCaptureResult {
  readonly name: string
  readonly status: 'failed'
  readonly error: unknown
  readonly cleanupFailures?: readonly unknown[]
}

/** One selected Recipe interrupted by caller cancellation. */
export interface CancelledCaptureResult {
  readonly name: string
  readonly status: 'cancelled'
  readonly reason: unknown
  readonly cleanupFailures?: readonly unknown[]
}

/** One selected Recipe not attempted after an earlier or request-level failure. */
export interface UnattemptedCaptureResult {
  readonly name: string
  readonly status: 'not-attempted'
  readonly reason: string
}

/** The result for exactly one selected Recipe. */
export type CaptureRecipeResult =
  CapturedRecipeResult | FailedCaptureResult | CancelledCaptureResult | UnattemptedCaptureResult

/** A site, browser, or owned-resource failure outside one Recipe attempt. */
export interface CaptureResourceFailure {
  readonly resource: 'site' | 'browser'
  readonly stage: 'startup' | 'cleanup'
  readonly error: unknown
}

/** Immutable accounting for one Run-level Capture request. */
export interface CaptureReport {
  readonly results: readonly CaptureRecipeResult[]
  readonly failures: readonly CaptureResourceFailure[]
  readonly operatorDestinations: readonly NetworkDestination[]
  readonly cancellation?: Readonly<{ reason: unknown }>
  readonly warnings?: readonly string[]
}

/** One selected Recipe whose Checking failed operationally. */
export interface FailedCheckResult {
  readonly name: string
  readonly status: 'failed'
  readonly error: unknown
  readonly cleanupFailures?: readonly unknown[]
}

/** One selected Recipe interrupted by caller cancellation. */
export interface CancelledCheckResult {
  readonly name: string
  readonly status: 'cancelled'
  readonly reason: unknown
  readonly cleanupFailures?: readonly unknown[]
}

/** One selected Recipe not checked after an earlier or request-level failure. */
export interface UnattemptedCheckResult {
  readonly name: string
  readonly status: 'not-attempted'
  readonly reason: string
}

/** One completed Checking finding rather than an operational failure. */
export type CheckFindingResult = Omit<Readonly<CheckResult>, 'status'> & {
  readonly status: 'same' | 'changed' | 'new' | 'skipped'
}

/** The Checking finding or operational result for exactly one selected Recipe. */
export type CheckRecipeResult =
  CheckFindingResult | FailedCheckResult | CancelledCheckResult | UnattemptedCheckResult

/** A resource failure outside one Recipe's Checking attempt. */
export interface CheckResourceFailure {
  readonly resource: 'site' | 'browser' | 'baseline'
  readonly stage: 'startup' | 'read' | 'cleanup'
  readonly error: unknown
}

/** Immutable accounting for one Run-level Checking request. */
export interface CheckReport {
  readonly results: readonly CheckRecipeResult[]
  readonly failures: readonly CheckResourceFailure[]
  readonly drift: readonly Drift[]
  readonly operatorDestinations: readonly NetworkDestination[]
  readonly cancellation?: Readonly<{ reason: unknown }>
  readonly warnings?: readonly string[]
}

/** Ordered facts emitted by Capture and Checking requests. */
export type RunProgress =
  | {
      readonly type: 'request-start'
      readonly operation: 'capture' | 'check'
      readonly recipes: readonly string[]
    }
  | {
      readonly type: 'recipe-start'
      readonly operation: 'capture' | 'check'
      readonly name: string
      readonly index: number
      readonly total: number
    }
  | ({ readonly type: 'retry'; readonly operation: 'capture' | 'check' } & Readonly<Retry>)
  | {
      readonly type: 'recipe-complete'
      readonly operation: 'capture' | 'check'
      readonly name: string
      readonly index: number
      readonly total: number
      readonly result: CaptureRecipeResult | CheckRecipeResult
    }
  | {
      readonly type: 'request-complete'
      readonly operation: 'capture' | 'check'
      readonly results: readonly (CaptureRecipeResult | CheckRecipeResult)[]
    }

const ACTIVE_REQUESTS = new WeakSet<Run>()

interface ProgressEmitter {
  readonly warnings: readonly string[]
  emit(progress: RunProgress): Promise<void>
}

/** Await progress in order and isolate the first observer failure. */
function progressEmitter(observer?: RunProgressObserver): ProgressEmitter {
  let active = observer
  const warnings: string[] = []
  return {
    warnings,
    async emit(progress) {
      if (!active) return
      try {
        await active(Object.freeze(progress))
      } catch (error) {
        active = undefined
        const why = error instanceof Error ? error.message : String(error)
        warnings.push(`Progress observer failed: ${why}`)
      }
    },
  }
}

/** Return the request cancellation represented by an aborted standard signal. */
function cancellationFrom(signal?: AbortSignal): RequestCancelledError | undefined {
  return signal?.aborted ? new RequestCancelledError(signal.reason) : undefined
}

/** Distinguish programming defects from operational failures a report can account for. */
function isUnexpectedDefect(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  )
}

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
  operatorDestinations: readonly NetworkDestination[]
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
  operatorDestinations: readonly NetworkDestination[]
}

/** Freeze one Capture result before reports or observers can publish it. */
function freezeCaptureResult(result: CaptureRecipeResult): CaptureRecipeResult {
  if (result.status === 'failed') {
    if (typeof result.error === 'object' && result.error !== null) Object.freeze(result.error)
  }
  if ((result.status === 'failed' || result.status === 'cancelled') && result.cleanupFailures) {
    for (const failure of result.cleanupFailures) {
      if (typeof failure === 'object' && failure !== null) Object.freeze(failure)
    }
    Object.freeze(result.cleanupFailures)
  }
  if (result.status === 'captured') {
    Object.freeze(result.shot.size)
    if (result.shot.ignored) {
      for (const rect of result.shot.ignored) Object.freeze(rect)
      Object.freeze(result.shot.ignored)
    }
    if (result.shot.warnings) Object.freeze(result.shot.warnings)
    Object.freeze(result.shot)
  }
  return Object.freeze(result)
}

/** Freeze one Run-level Capture report and every result record it owns. */
function captureReport(
  run: Run,
  results: readonly CaptureRecipeResult[],
  failures: readonly CaptureResourceFailure[] = [],
  facts: Readonly<{ cancellation?: unknown; warnings?: readonly string[] }> = {},
): CaptureReport {
  for (const result of results) freezeCaptureResult(result)
  for (const failure of failures) {
    if (typeof failure.error === 'object' && failure.error !== null) Object.freeze(failure.error)
    Object.freeze(failure)
  }
  const operatorDestinations = Object.freeze(
    run.operatorDestinations.map((destination) => Object.freeze({ ...destination })),
  )
  const cancellation =
    facts.cancellation === undefined ? undefined : Object.freeze({ reason: facts.cancellation })
  return Object.freeze({
    results: Object.freeze([...results]),
    failures: Object.freeze([...failures]),
    operatorDestinations,
    ...(cancellation ? { cancellation } : {}),
    ...(facts.warnings?.length ? { warnings: Object.freeze([...facts.warnings]) } : {}),
  })
}

/** Resolve, validate, and snapshot one complete Run request before effects. */
function selectedRecipes(
  run: Run,
  request: CaptureRequest | CheckRequest,
  operation: 'Capture' | 'Checking',
): {
  recipes: readonly DeepReadonly<Recipe>[]
  keepGoing?: boolean
  signal?: AbortSignal
  onProgress?: RunProgressObserver
} {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new ShotlistError(`A ${operation} request is required`)
  }
  const keepGoing = request.keepGoing
  const signal = request.signal
  const onProgress = request.onProgress
  if (keepGoing !== undefined && typeof keepGoing !== 'boolean') {
    throw new ShotlistError(`${operation} request \`keepGoing\` must be a boolean`)
  }
  if (
    signal !== undefined &&
    (typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new ShotlistError(`${operation} request \`signal\` must be an AbortSignal`)
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new ShotlistError(`${operation} request \`onProgress\` must be a function`)
  }
  const hasNames = Object.hasOwn(request, 'recipes')
  const hasAll = Object.hasOwn(request, 'all')
  if (hasNames === hasAll) {
    throw new ShotlistError(
      `A ${operation} request selects either \`recipes\` or \`all: true\`, never both`,
    )
  }
  if (hasAll) {
    const all = request.all
    if (all !== true) {
      throw new ShotlistError(
        `A ${operation} request selects either \`recipes\` or \`all: true\`, never both`,
      )
    }
    const recipes = [...run.project.library.recipes.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, recipe]) => recipe)
    return Object.freeze({ recipes: Object.freeze(recipes), keepGoing, signal, onProgress })
  }

  const names = request.recipes
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new ShotlistError(`${operation} request \`recipes\` must be a list of Recipe names`)
  }
  if (!names.length) {
    throw new ShotlistError(
      `${operation} request \`recipes\` must contain at least one Recipe name`,
    )
  }
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const unknown = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
    if (!run.project.library.recipes.has(name)) unknown.add(name)
  }
  if (duplicates.size || unknown.size) {
    const details = [
      ...(duplicates.size ? [`duplicate Recipe names: ${[...duplicates].sort().join(', ')}`] : []),
      ...(unknown.size ? [`unknown Recipe names: ${[...unknown].sort().join(', ')}`] : []),
    ]
    throw new ShotlistError(`Invalid ${operation} request — ${details.join('; ')}`)
  }
  return Object.freeze({
    recipes: Object.freeze(names.map((name) => run.project.library.recipes.get(name)!)),
    keepGoing,
    signal,
    onProgress,
  })
}

/** Capture one validated selection through request-owned site and browser lifetimes. */
async function performCaptureRequest(
  run: Run,
  recipes: readonly DeepReadonly<Recipe>[],
  options: Readonly<{
    keepGoing?: boolean
    signal?: AbortSignal
    progress: ProgressEmitter
  }>,
): Promise<CaptureReport> {
  if (!recipes.length) return captureReport(run, [])

  const results: CaptureRecipeResult[] = []
  const failures: CaptureResourceFailure[] = []
  let cancellation = cancellationFrom(options.signal)
  let server: Awaited<ReturnType<typeof startServer>> = null
  let browser: Browser | undefined

  if (cancellation) {
    return captureReport(
      run,
      recipes.map((recipe) => ({
        name: recipe.name!,
        status: 'not-attempted',
        reason: 'request was cancelled',
      })),
      failures,
      { cancellation: cancellation.reason },
    )
  }

  if (recipes.some((recipe) => recipe.source === 'app')) {
    try {
      server = await startServer(run)
    } catch (error) {
      cancellation = cancellationFrom(options.signal)
      if (cancellation) {
        return captureReport(
          run,
          recipes.map((recipe) => ({
            name: recipe.name!,
            status: 'not-attempted',
            reason: 'request was cancelled',
          })),
          failures,
          { cancellation: cancellation.reason },
        )
      }
      if (isUnexpectedDefect(error)) throw error
      failures.push({ resource: 'site', stage: 'startup', error })
      return captureReport(
        run,
        recipes.map((recipe) => ({
          name: recipe.name!,
          status: 'not-attempted',
          reason: 'site startup failed',
        })),
        failures,
      )
    }
  }

  try {
    cancellation = cancellationFrom(options.signal)
    if (!cancellation) {
      try {
        browser = await loadPlaywright().chromium.launch()
      } catch (error) {
        if (isUnexpectedDefect(error)) throw error
        failures.push({ resource: 'browser', stage: 'startup', error })
      }
    }

    if (browser) {
      let stopped = false
      for (const [index, recipe] of recipes.entries()) {
        cancellation = cancellationFrom(options.signal)
        if (cancellation) {
          for (const remaining of recipes.slice(index)) {
            results.push({
              name: remaining.name!,
              status: 'not-attempted',
              reason: 'request was cancelled',
            })
          }
          break
        }
        if (stopped) {
          results.push({
            name: recipe.name!,
            status: 'not-attempted',
            reason: 'an earlier Capture failed',
          })
          continue
        }

        await options.progress.emit({
          type: 'recipe-start',
          operation: 'capture',
          name: recipe.name!,
          index,
          total: recipes.length,
        })
        let completed: CaptureRecipeResult
        try {
          const shot = await shoot(run, recipe, {
            browser,
            signal: options.signal,
            onRetry: (retry) =>
              options.progress.emit({ type: 'retry', operation: 'capture', ...retry }),
          })
          completed = { name: recipe.name!, status: 'captured', shot }
          results.push(completed)
        } catch (error) {
          if (isUnexpectedDefect(error)) throw error
          const cleanupFailures = captureCleanupFailures(error)
          if (error instanceof RequestCancelledError) {
            cancellation = error
            completed = {
              name: recipe.name!,
              status: 'cancelled',
              reason: error.reason,
              ...(cleanupFailures.length ? { cleanupFailures } : {}),
            }
            results.push(completed)
            for (const remaining of recipes.slice(index + 1)) {
              results.push({
                name: remaining.name!,
                status: 'not-attempted',
                reason: 'request was cancelled',
              })
            }
          } else {
            completed = {
              name: recipe.name!,
              status: 'failed',
              error,
              ...(cleanupFailures.length ? { cleanupFailures } : {}),
            }
            results.push(completed)
            stopped = !options.keepGoing
            if (stopped) {
              for (const remaining of recipes.slice(index + 1)) {
                results.push({
                  name: remaining.name!,
                  status: 'not-attempted',
                  reason: 'an earlier Capture failed',
                })
              }
            }
          }
        }
        freezeCaptureResult(completed)
        await options.progress.emit({
          type: 'recipe-complete',
          operation: 'capture',
          name: recipe.name!,
          index,
          total: recipes.length,
          result: completed,
        })
        if (cancellation || stopped) break
      }
    } else {
      const reason = cancellation ? 'request was cancelled' : 'browser startup failed'
      results.push(
        ...recipes.map((recipe) => ({
          name: recipe.name!,
          status: 'not-attempted' as const,
          reason,
        })),
      )
    }
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch (error) {
        failures.push({ resource: 'browser', stage: 'cleanup', error })
      }
    }
    try {
      await server?.stop()
    } catch (error) {
      failures.push({ resource: 'site', stage: 'cleanup', error })
    }
  }
  return captureReport(run, results, failures, {
    ...(cancellation ? { cancellation: cancellation.reason } : {}),
  })
}

/** Validate and Capture one request while keeping the Run reusable but non-overlapping. */
export async function captureRun(run: Run, request: CaptureRequest): Promise<CaptureReport> {
  assertRun(run)
  const { recipes, keepGoing, signal, onProgress } = selectedRecipes(run, request, 'Capture')
  const progress = progressEmitter(onProgress)
  const options = Object.freeze({
    ...(keepGoing !== undefined ? { keepGoing } : {}),
    ...(signal !== undefined ? { signal } : {}),
    progress,
  })
  if (ACTIVE_REQUESTS.has(run)) {
    throw new ShotlistError('This Run is already executing a request')
  }
  ACTIVE_REQUESTS.add(run)
  try {
    await progress.emit({
      type: 'request-start',
      operation: 'capture',
      recipes: Object.freeze(recipes.map((recipe) => recipe.name!)),
    })
    const report = await performCaptureRequest(run, recipes, options)
    await progress.emit({
      type: 'request-complete',
      operation: 'capture',
      results: report.results,
    })
    return captureReport(run, report.results, report.failures, {
      ...(report.cancellation ? { cancellation: report.cancellation.reason } : {}),
      warnings: progress.warnings,
    })
  } finally {
    ACTIVE_REQUESTS.delete(run)
  }
}

/** Freeze one Checking result before reports or observers can publish it. */
function freezeCheckResult(result: CheckRecipeResult): CheckRecipeResult {
  if (result.status === 'failed') {
    if (typeof result.error === 'object' && result.error !== null) Object.freeze(result.error)
  }
  if ((result.status === 'failed' || result.status === 'cancelled') && result.cleanupFailures) {
    for (const failure of result.cleanupFailures) {
      if (typeof failure === 'object' && failure !== null) Object.freeze(failure)
    }
    Object.freeze(result.cleanupFailures)
  }
  return Object.freeze(result)
}

/** Freeze one Checking report and the nested facts it owns. */
function checkReport(
  run: Run,
  results: readonly CheckRecipeResult[],
  failures: readonly CheckResourceFailure[] = [],
  drift: readonly Drift[] = [],
  facts: Readonly<{ cancellation?: unknown; warnings?: readonly string[] }> = {},
): CheckReport {
  for (const result of results) freezeCheckResult(result)
  for (const failure of failures) {
    if (typeof failure.error === 'object' && failure.error !== null) Object.freeze(failure.error)
    Object.freeze(failure)
  }
  for (const item of drift) Object.freeze(item)
  const operatorDestinations = Object.freeze(
    run.operatorDestinations.map((destination) => Object.freeze({ ...destination })),
  )
  const cancellation =
    facts.cancellation === undefined ? undefined : Object.freeze({ reason: facts.cancellation })
  return Object.freeze({
    results: Object.freeze([...results]),
    failures: Object.freeze([...failures]),
    drift: Object.freeze([...drift]),
    operatorDestinations,
    ...(cancellation ? { cancellation } : {}),
    ...(facts.warnings?.length ? { warnings: Object.freeze([...facts.warnings]) } : {}),
  })
}

/** Perform one validated Checking selection through request-owned resources. */
async function performCheckRequest(
  run: Run,
  recipes: readonly DeepReadonly<Recipe>[],
  options: Readonly<{
    keepGoing?: boolean
    diff?: boolean
    signal?: AbortSignal
    progress: ProgressEmitter
  }>,
): Promise<CheckReport> {
  if (!recipes.length) return checkReport(run, [])

  const skipped = new Map<DeepReadonly<Recipe>, CheckFindingResult>(
    recipes.flatMap((recipe) => {
      const result = skippedCheckResult(run, recipe)
      return result ? [[recipe, result as CheckFindingResult] as const] : []
    }),
  )
  const actionable = recipes.filter((recipe) => !skipped.has(recipe))
  /** Preserve completed skipped findings while cancellation accounts for actionable work. */
  const afterCancellation = (candidates: readonly DeepReadonly<Recipe>[]): CheckRecipeResult[] =>
    candidates.map(
      (recipe) =>
        skipped.get(recipe) ?? {
          name: recipe.name!,
          status: 'not-attempted',
          reason: 'request was cancelled',
        },
    )
  const results: CheckRecipeResult[] = []
  const failures: CheckResourceFailure[] = []
  let cancellation = cancellationFrom(options.signal)
  let drift: readonly Drift[] = []
  let server: Awaited<ReturnType<typeof startServer>> = null
  let browser: Browser | undefined

  if (cancellation) {
    return checkReport(run, afterCancellation(recipes), failures, drift, {
      cancellation: cancellation.reason,
    })
  }

  if (!actionable.length) {
    for (const [index, recipe] of recipes.entries()) {
      await options.progress.emit({
        type: 'recipe-start',
        operation: 'check',
        name: recipe.name!,
        index,
        total: recipes.length,
      })
      const result = freezeCheckResult(skipped.get(recipe)!)
      results.push(result)
      await options.progress.emit({
        type: 'recipe-complete',
        operation: 'check',
        name: recipe.name!,
        index,
        total: recipes.length,
        result,
      })
    }
    return checkReport(run, results)
  }

  if (actionable.some((recipe) => recipe.source === 'app')) {
    try {
      server = await startServer(run)
    } catch (error) {
      cancellation = cancellationFrom(options.signal)
      if (cancellation) {
        return checkReport(run, afterCancellation(recipes), failures, drift, {
          cancellation: cancellation.reason,
        })
      }
      if (isUnexpectedDefect(error)) throw error
      failures.push({ resource: 'site', stage: 'startup', error })
      return checkReport(
        run,
        recipes.map(
          (recipe) =>
            skipped.get(recipe) ?? {
              name: recipe.name!,
              status: 'not-attempted',
              reason: 'site startup failed',
            },
        ),
        failures,
      )
    }
  }

  try {
    cancellation = cancellationFrom(options.signal)
    if (!cancellation) {
      try {
        browser = await loadPlaywright().chromium.launch()
      } catch (error) {
        if (isUnexpectedDefect(error)) throw error
        failures.push({ resource: 'browser', stage: 'startup', error })
      }
    }

    if (browser) {
      try {
        drift = environmentDrift(readBaseline(run), describeEnvironment(browser))
      } catch (error) {
        if (isUnexpectedDefect(error)) throw error
        failures.push({ resource: 'baseline', stage: 'read', error })
      }

      if (!failures.length) {
        let stopped = false
        for (const [index, recipe] of recipes.entries()) {
          cancellation = cancellationFrom(options.signal)
          if (cancellation) {
            results.push(...afterCancellation(recipes.slice(index)))
            break
          }
          const skippedResult = skipped.get(recipe)
          if (stopped && !skippedResult) {
            results.push({
              name: recipe.name!,
              status: 'not-attempted',
              reason: 'an earlier Checking attempt failed',
            })
            continue
          }

          await options.progress.emit({
            type: 'recipe-start',
            operation: 'check',
            name: recipe.name!,
            index,
            total: recipes.length,
          })
          let completed: CheckRecipeResult
          if (skippedResult) {
            completed = skippedResult
            results.push(completed)
          } else {
            try {
              const [result] = await check(run, [recipe], {
                browser,
                signal: options.signal,
                onRetry: (retry) =>
                  options.progress.emit({ type: 'retry', operation: 'check', ...retry }),
                ...(options.diff
                  ? { diffDir: join(fromRoot(run.project, run.project.config.paths.out), 'diff') }
                  : {}),
              })
              completed = result as CheckFindingResult
              results.push(completed)
            } catch (error) {
              if (isUnexpectedDefect(error)) throw error
              const cleanupFailures = captureCleanupFailures(error)
              if (error instanceof RequestCancelledError) {
                cancellation = error
                completed = {
                  name: recipe.name!,
                  status: 'cancelled',
                  reason: error.reason,
                  ...(cleanupFailures.length ? { cleanupFailures } : {}),
                }
                results.push(completed)
                results.push(...afterCancellation(recipes.slice(index + 1)))
              } else {
                completed = {
                  name: recipe.name!,
                  status: 'failed',
                  error,
                  ...(cleanupFailures.length ? { cleanupFailures } : {}),
                }
                results.push(completed)
                stopped = !options.keepGoing
              }
            }
          }
          freezeCheckResult(completed)
          await options.progress.emit({
            type: 'recipe-complete',
            operation: 'check',
            name: recipe.name!,
            index,
            total: recipes.length,
            result: completed,
          })
          if (cancellation) break
        }
      }
    }

    if (!browser || failures.some((failure) => failure.resource === 'baseline')) {
      const reason = cancellation
        ? 'request was cancelled'
        : browser
          ? 'Baseline could not be read'
          : 'browser startup failed'
      results.push(
        ...recipes.map(
          (recipe) =>
            skipped.get(recipe) ?? {
              name: recipe.name!,
              status: 'not-attempted' as const,
              reason,
            },
        ),
      )
    }
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch (error) {
        failures.push({ resource: 'browser', stage: 'cleanup', error })
      }
    }
    try {
      await server?.stop()
    } catch (error) {
      failures.push({ resource: 'site', stage: 'cleanup', error })
    }
  }
  return checkReport(run, results, failures, drift, {
    ...(cancellation ? { cancellation: cancellation.reason } : {}),
  })
}

/** Validate and perform Checking while keeping the Run reusable but non-overlapping. */
export async function checkRun(run: Run, request: CheckRequest): Promise<CheckReport> {
  assertRun(run)
  const { recipes, keepGoing, signal, onProgress } = selectedRecipes(run, request, 'Checking')
  const diff = request.diff
  if (diff !== undefined && typeof diff !== 'boolean') {
    throw new ShotlistError('Checking request `diff` must be a boolean')
  }
  const progress = progressEmitter(onProgress)
  const options = Object.freeze({
    ...(keepGoing !== undefined ? { keepGoing } : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(signal !== undefined ? { signal } : {}),
    progress,
  })
  if (ACTIVE_REQUESTS.has(run)) {
    throw new ShotlistError('This Run is already executing a request')
  }
  ACTIVE_REQUESTS.add(run)
  try {
    await progress.emit({
      type: 'request-start',
      operation: 'check',
      recipes: Object.freeze(recipes.map((recipe) => recipe.name!)),
    })
    const report = await performCheckRequest(run, recipes, options)
    await progress.emit({
      type: 'request-complete',
      operation: 'check',
      results: report.results,
    })
    return checkReport(run, report.results, report.failures, report.drift, {
      ...(report.cancellation ? { cancellation: report.cancellation.reason } : {}),
      warnings: progress.warnings,
    })
  } finally {
    ACTIVE_REQUESTS.delete(run)
  }
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
      operatorDestinations: run.operatorDestinations,
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
      return { results, drift, operatorDestinations: run.operatorDestinations }
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
    withBrowser(
      async (
        browser,
      ): Promise<Omit<CaptureRunResult, 'baselineRecorded' | 'operatorDestinations'>> => {
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
      },
    )

  const captured = candidates.some((recipe) => recipe.source === 'app')
    ? await withServer(run, work)
    : await work()
  const baselineRecorded = Boolean(options.install && !captured.failures.length)
  if (baselineRecorded) writeBaseline(run, environment!)
  return { ...captured, baselineRecorded, operatorDestinations: run.operatorDestinations }
}
