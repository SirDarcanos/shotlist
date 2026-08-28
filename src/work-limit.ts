import { ShotlistError } from './config.js'
import { MAX_MATCHING_CHARACTERS, validateMatchingIn } from './matching.js'
import { foldPredictableSteps, visitAuthoredSteps } from './step.js'
import type { PredictableFold, StepInput } from './step.js'
import { WorkLimitError } from './work.js'
import type { StepWork, WorkLimitName, WorkLimitOverrides, WorkLimits } from './work.js'
export {
  MAX_MATCHING_CHARACTERS,
  matchingMeasurementsIn,
  validateMatching,
  validateMatchingIn,
} from './matching.js'
export { WorkLimitError } from './work.js'
export type { StepWork, WorkLimitName, WorkLimitOverrides, WorkLimits } from './work.js'

/** Safe Work limits applied to every Run unless the Operator changes a numerical value. */
export const DEFAULT_WORK_LIMITS: Readonly<WorkLimits> = Object.freeze({
  recipeBytes: 1024 * 1024,
  macroBytes: 1024 * 1024,
  dataBytes: 10 * 1024 * 1024,
  authoredSteps: 1000,
  stepDepth: 32,
  macroDepth: 32,
  expandedSteps: 5000,
  executedSteps: 10_000,
  eachItems: 1000,
  matchingCharacters: MAX_MATCHING_CHARACTERS,
  recipeMilliseconds: 10 * 60_000,
  teardownSteps: 1000,
  teardownMilliseconds: 60_000,
})

export const MAX_STEP_DEPTH = DEFAULT_WORK_LIMITS.stepDepth

interface WorkDeadline {
  readonly signal: AbortSignal
  readonly error: WorkLimitError
  readonly expiresAt: number
}

/** Create one Executed Step meter for an attempt, teardown, or scripted sign-in. */
export function createStepWork(
  limits: Readonly<WorkLimits>,
  phase: 'attempt' | 'teardown' | 'sign-in' = 'attempt',
  deadline?: WorkDeadline,
): StepWork {
  const allowed = phase === 'teardown' ? limits.teardownSteps : limits.executedSteps
  let executed = 0
  return {
    ...(deadline ? { signal: deadline.signal } : {}),
    step() {
      if (deadline?.signal.aborted) throw deadline.signal.reason ?? deadline.error
      if (deadline && Date.now() >= deadline.expiresAt) throw deadline.error
      executed++
      if (executed > allowed) {
        throw new WorkLimitError(
          `${phase === 'teardown' ? 'teardown' : phase === 'sign-in' ? 'scripted sign-in' : 'Recipe'} ran more than ${allowed} Step${allowed === 1 ? '' : 's'}; the Work limit is ${allowed}`,
          phase === 'teardown' ? 'teardownSteps' : 'executedSteps',
          executed,
          allowed,
        )
      }
    },
    each(items) {
      if (items > limits.eachItems) {
        throw new WorkLimitError(
          `each would process ${items} items; the Work limit is ${limits.eachItems}`,
          'eachItems',
          items,
          limits.eachItems,
        )
      }
    },
    matching(value) {
      try {
        validateMatchingIn(value, limits.matchingCharacters)
      } catch (error) {
        throw new WorkLimitError(
          (error as Error).message,
          'matchingCharacters',
          limits.matchingCharacters + 1,
          limits.matchingCharacters,
          undefined,
          false,
        )
      }
    },
    async run<T>(operation: () => Promise<T>, stop?: () => Promise<void>): Promise<T> {
      if (!deadline) return operation()
      if (deadline.signal.aborted || Date.now() >= deadline.expiresAt) {
        await stop?.()
        throw deadline.signal.reason ?? deadline.error
      }
      return new Promise<T>((resolve, reject) => {
        const running = operation()
        let timedOut = false
        const expired = () => {
          timedOut = true
          void (async () => {
            try {
              await stop?.()
            } finally {
              reject(deadline.signal.reason ?? deadline.error)
            }
          })()
        }
        deadline.signal.addEventListener('abort', expired, { once: true })
        void running.then(
          (value) => {
            deadline.signal.removeEventListener('abort', expired)
            if (!timedOut) resolve(value)
          },
          (error: unknown) => {
            deadline.signal.removeEventListener('abort', expired)
            if (!timedOut) reject(error)
          },
        )
      })
    },
  }
}

export interface RecipeWork {
  attempt(): StepWork
  teardown(): StepWork
  /** Await observation without charging its elapsed time to the Recipe. */
  observe<T>(observer: () => Promise<T>): Promise<T>
  dispose(): void
}

/** A caller cancelled one request without cancelling its reusable Run. */
export class RequestCancelledError extends ShotlistError {
  readonly code = 'SHOTLIST_REQUEST_CANCELLED'

  constructor(readonly reason: unknown) {
    super('The request was cancelled')
  }
}

/** Start one deadline shared by every attempt plus a bounded cleanup reserve. */
export function createRecipeWork(
  limits: Readonly<WorkLimits>,
  recipe: string,
  signal?: AbortSignal,
): RecipeWork {
  const startedAt = Date.now()
  let mainExpiresAt = startedAt + limits.recipeMilliseconds
  let cleanupExpiresAt = mainExpiresAt + limits.teardownMilliseconds
  const main = new AbortController()
  const cleanup = new AbortController()
  const mainError = new WorkLimitError(
    `recipe "${recipe}" reached its ${limits.recipeMilliseconds}ms Work limit`,
    'recipeMilliseconds',
    limits.recipeMilliseconds + 1,
    limits.recipeMilliseconds,
  )
  const cleanupError = new WorkLimitError(
    `recipe "${recipe}" teardown reached its ${limits.teardownMilliseconds}ms Work limit`,
    'teardownMilliseconds',
    limits.teardownMilliseconds + 1,
    limits.teardownMilliseconds,
  )
  let mainTimer: ReturnType<typeof setTimeout>
  let cleanupTimer: ReturnType<typeof setTimeout>
  const teardownTimers = new Set<ReturnType<typeof setTimeout>>()
  const schedule = () => {
    mainTimer = setTimeout(() => main.abort(mainError), Math.max(0, mainExpiresAt - Date.now()))
    cleanupTimer = setTimeout(
      () => cleanup.abort(cleanupError),
      Math.max(0, cleanupExpiresAt - Date.now()),
    )
    mainTimer.unref?.()
    cleanupTimer.unref?.()
  }
  const cancelled = () => main.abort(new RequestCancelledError(signal?.reason))
  if (signal?.aborted) cancelled()
  else signal?.addEventListener('abort', cancelled, { once: true })
  schedule()
  const mainDeadline: WorkDeadline = {
    signal: main.signal,
    error: mainError,
    get expiresAt() {
      return mainExpiresAt
    },
  }
  return {
    attempt: () => createStepWork(limits, 'attempt', mainDeadline),
    teardown: () => {
      const phase = new AbortController()
      const expire = () => phase.abort(cleanupError)
      if (cleanup.signal.aborted) expire()
      else cleanup.signal.addEventListener('abort', expire, { once: true })
      const timer = setTimeout(expire, limits.teardownMilliseconds)
      timer.unref?.()
      teardownTimers.add(timer)
      return createStepWork(limits, 'teardown', {
        signal: phase.signal,
        error: cleanupError,
        expiresAt: Math.min(Date.now() + limits.teardownMilliseconds, cleanupExpiresAt),
      })
    },
    async observe<T>(observer: () => Promise<T>): Promise<T> {
      if (main.signal.aborted) throw main.signal.reason
      clearTimeout(mainTimer)
      clearTimeout(cleanupTimer)
      const pausedAt = Date.now()
      try {
        return await observer()
      } finally {
        const paused = Date.now() - pausedAt
        mainExpiresAt += paused
        cleanupExpiresAt += paused
        if (!main.signal.aborted && !cleanup.signal.aborted) schedule()
      }
    },
    dispose() {
      clearTimeout(mainTimer)
      clearTimeout(cleanupTimer)
      signal?.removeEventListener('abort', cancelled)
      for (const timer of teardownTimers) clearTimeout(timer)
    },
  }
}

/** Validate and freeze numerical changes without filling unspecified defaults. */
export function workLimitOverrides(value: unknown): WorkLimitOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShotlistError('Operator authority `workLimits` must be a mapping')
  }
  const known = new Set(Object.keys(DEFAULT_WORK_LIMITS))
  const overrides: Partial<Record<WorkLimitName, number>> = {}
  for (const [name, amount] of Object.entries(value)) {
    if (!known.has(name)) throw new ShotlistError(`unknown Work limit "${name}"`)
    if (!Number.isSafeInteger(amount) || Number(amount) <= 0) {
      throw new ShotlistError(`Work limit "${name}" must be a positive whole number`)
    }
    overrides[name as WorkLimitName] = Number(amount)
  }
  return Object.freeze(overrides)
}

/** Parse Operator-owned `name=value` Work limit settings. */
export function parseWorkLimitChanges(values: readonly string[]): WorkLimitOverrides {
  const changes: Partial<Record<WorkLimitName, number>> = {}
  for (const authored of values) {
    const matched = /^([A-Za-z][A-Za-z0-9]*)=(\d+)$/.exec(authored.trim())
    if (!matched) {
      throw new ShotlistError(
        `Work limit "${authored}" is invalid; use a name and positive whole number such as executedSteps=20000`,
      )
    }
    changes[matched[1] as WorkLimitName] = Number(matched[2])
  }
  return workLimitOverrides(changes)
}

/** Work limit settings from the Operator's protected process environment. */
export function workLimitsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): WorkLimitOverrides {
  const authored = environment['SHOTLIST_WORK_LIMITS'] ?? ''
  return parseWorkLimitChanges(authored.split(/[\s,]+/).filter(Boolean))
}

/** Resolve and freeze safe defaults plus numerical changes granted by the Operator. */
export function resolveWorkLimits(overrides: WorkLimitOverrides = {}): Readonly<WorkLimits> {
  return Object.freeze({ ...DEFAULT_WORK_LIMITS, ...workLimitOverrides(overrides) })
}

/** Whether a measurement has reached the shared eighty-percent warning threshold. */
export function nearWorkLimit(observed: number, allowed: number): boolean {
  return observed >= Math.ceil(allowed * 0.8) && observed <= allowed
}

export interface AuthoredWork {
  readonly count: number
  readonly depth: number
}

interface WorkMacro {
  readonly defaults: Readonly<Record<string, unknown>>
  readonly steps: readonly StepInput[]
}

interface WorkRecipe {
  readonly name?: string
  readonly setup: readonly StepInput[]
  readonly teardown: readonly StepInput[]
}

interface WorkLibrary {
  readonly recipes: ReadonlyMap<string, WorkRecipe>
  readonly macros: ReadonlyMap<string, WorkMacro>
  readonly data: Readonly<Record<string, unknown>>
}

export interface PlannedWork {
  readonly expanded: number
  readonly executed: number
  readonly milliseconds: number
  readonly eachItems: number
  readonly macroDepth: number
}

/** Saturate accumulated work before JavaScript loses integer precision. */
function boundedArithmetic(value: number): number {
  return Math.min(value, Number.MAX_SAFE_INTEGER)
}

/** Construct Work-policy arithmetic for the declaration-driven Step fold. */
function planningFold(
  limits: Readonly<WorkLimits>,
  executionLimit: number,
  timeLimit: number,
): PredictableFold<PlannedWork> {
  const none = (): PlannedWork => ({
    expanded: 0,
    executed: 0,
    milliseconds: 0,
    eachItems: 0,
    macroDepth: 0,
  })
  const exceeded = (work: PlannedWork) =>
    work.expanded > limits.expandedSteps ||
    work.executed > executionLimit ||
    work.milliseconds > timeLimit
  const add = (left: PlannedWork, right: PlannedWork): PlannedWork => ({
    expanded: boundedArithmetic(left.expanded + right.expanded),
    executed: boundedArithmetic(left.executed + right.executed),
    milliseconds: boundedArithmetic(left.milliseconds + right.milliseconds),
    eachItems: Math.max(left.eachItems, right.eachItems),
    macroDepth: Math.max(left.macroDepth, right.macroDepth),
  })

  return {
    sequence(parts) {
      let measured = none()
      for (const part of parts) {
        measured = add(measured, part())
        if (exceeded(measured)) break
      }
      return measured
    },
    one(milliseconds = 0) {
      return { ...none(), expanded: 1, executed: 1, milliseconds }
    },
    repetition(times, body) {
      const nested = body()
      return {
        ...nested,
        executed: boundedArithmetic(nested.executed * times),
        milliseconds: boundedArithmetic(nested.milliseconds * times),
      }
    },
    knownIteration(items, body, empty) {
      if (items.length > limits.eachItems) {
        throw new WorkLimitError(
          `each would process ${items.length} items; the Work limit is ${limits.eachItems}`,
          'eachItems',
          items.length,
          limits.eachItems,
        )
      }
      if (!items.length) {
        const nested = empty()
        return {
          ...nested,
          executed: 0,
          milliseconds: 0,
          eachItems: Math.max(nested.eachItems, items.length),
        }
      }

      let measured = none()
      for (const item of items) {
        const nested = body(item)
        measured = {
          expanded: Math.max(measured.expanded, nested.expanded),
          executed: boundedArithmetic(measured.executed + nested.executed),
          milliseconds: boundedArithmetic(measured.milliseconds + nested.milliseconds),
          eachItems: Math.max(items.length, measured.eachItems, nested.eachItems),
          macroDepth: Math.max(measured.macroDepth, nested.macroDepth),
        }
        if (exceeded(measured)) break
      }
      return measured
    },
    macroExpansion(depth, body) {
      if (depth > limits.macroDepth) {
        throw new WorkLimitError(
          `Macro expansion is more than ${limits.macroDepth} deep; the Work limit is ${limits.macroDepth}`,
          'macroDepth',
          depth,
          limits.macroDepth,
        )
      }
      const nested = body()
      return { ...nested, macroDepth: Math.max(depth, nested.macroDepth) }
    },
  }
}

/** Calculate predictable work through Step declaration semantics. */
function planSteps(
  steps: readonly StepInput[],
  library: WorkLibrary,
  limits: Readonly<WorkLimits>,
  scope: Readonly<Record<string, unknown>>,
  executionLimit = limits.executedSteps,
  timeLimit = limits.recipeMilliseconds,
): PlannedWork {
  return foldPredictableSteps(
    steps,
    library.macros,
    scope,
    planningFold(limits, executionLimit, timeLimit),
  )
}

export interface RecipeWorkMeasurement {
  readonly setup: PlannedWork
  readonly teardown: PlannedWork
}

/** Measure and refuse one Recipe's predictable work before browser startup. */
export function preflightRecipe(
  name: string,
  recipe: WorkRecipe,
  library: WorkLibrary,
  limits: Readonly<WorkLimits> = DEFAULT_WORK_LIMITS,
): RecipeWorkMeasurement {
  const setup = planSteps(recipe.setup, library, limits, library.data)
  if (setup.expanded > limits.expandedSteps) {
    throw new WorkLimitError(
      `recipe "${name}" expands to more than ${limits.expandedSteps} Steps; the Work limit is ${limits.expandedSteps}`,
      'expandedSteps',
      setup.expanded,
      limits.expandedSteps,
    )
  }
  if (setup.executed > limits.executedSteps) {
    throw new WorkLimitError(
      `recipe "${name}" would run ${setup.executed} Steps; the Work limit is ${limits.executedSteps}`,
      'executedSteps',
      setup.executed,
      limits.executedSteps,
    )
  }
  if (setup.milliseconds > limits.recipeMilliseconds) {
    throw new WorkLimitError(
      `recipe "${name}" would deliberately wait ${setup.milliseconds}ms; the Work limit is ${limits.recipeMilliseconds}ms`,
      'recipeMilliseconds',
      setup.milliseconds,
      limits.recipeMilliseconds,
    )
  }
  const teardown = planSteps(
    recipe.teardown,
    library,
    limits,
    library.data,
    limits.teardownSteps,
    limits.teardownMilliseconds,
  )
  if (teardown.expanded > limits.expandedSteps) {
    throw new WorkLimitError(
      `recipe "${name}" teardown expands to more than ${limits.expandedSteps} Steps; the Work limit is ${limits.expandedSteps}`,
      'expandedSteps',
      teardown.expanded,
      limits.expandedSteps,
    )
  }
  if (teardown.executed > limits.teardownSteps) {
    throw new WorkLimitError(
      `recipe "${name}" teardown would run ${teardown.executed} Steps; the Work limit is ${limits.teardownSteps}`,
      'teardownSteps',
      teardown.executed,
      limits.teardownSteps,
    )
  }
  if (teardown.milliseconds > limits.teardownMilliseconds) {
    throw new WorkLimitError(
      `recipe "${name}" teardown would deliberately wait ${teardown.milliseconds}ms; the Work limit is ${limits.teardownMilliseconds}ms`,
      'teardownMilliseconds',
      teardown.milliseconds,
      limits.teardownMilliseconds,
    )
  }
  return { setup, teardown }
}

/** Refuse predictable scripted sign-in work before it can open a browser. */
export function preflightMacro(
  name: string,
  library: WorkLibrary,
  limits: Readonly<WorkLimits> = DEFAULT_WORK_LIMITS,
): PlannedWork {
  const planned = planSteps([{ use: name }], library, limits, library.data)
  if (planned.expanded > limits.expandedSteps) {
    throw new WorkLimitError(
      `macro "${name}" expands to more than ${limits.expandedSteps} Steps; the Work limit is ${limits.expandedSteps}`,
      'expandedSteps',
      planned.expanded,
      limits.expandedSteps,
    )
  }
  if (planned.executed > limits.executedSteps) {
    throw new WorkLimitError(
      `macro "${name}" would run ${planned.executed} Steps; the Work limit is ${limits.executedSteps}`,
      'executedSteps',
      planned.executed,
      limits.executedSteps,
    )
  }
  if (planned.milliseconds > limits.recipeMilliseconds) {
    throw new WorkLimitError(
      `macro "${name}" would deliberately wait ${planned.milliseconds}ms; the Work limit is ${limits.recipeMilliseconds}ms`,
      'recipeMilliseconds',
      planned.milliseconds,
      limits.recipeMilliseconds,
    )
  }
  return planned
}

/** Refuse predictable Library work before a Run can start its site or browser. */
export function preflightLibrary(
  library: WorkLibrary,
  limits: Readonly<WorkLimits> = DEFAULT_WORK_LIMITS,
): void {
  for (const name of library.macros.keys()) preflightMacro(name, library, limits)
  for (const [name, recipe] of library.recipes) preflightRecipe(name, recipe, library, limits)
}

/** Count authored Steps iteratively so excessive nesting cannot overflow the checker. */
export function authoredWork(
  raw: unknown,
  roots: readonly string[],
  limits: Pick<WorkLimits, 'authoredSteps' | 'stepDepth'> | undefined = DEFAULT_WORK_LIMITS,
  file?: string,
): AuthoredWork {
  limits = limits ?? DEFAULT_WORK_LIMITS
  let count = 0
  let deepest = 0

  visitAuthoredSteps(raw, roots, ({ path, depth }) => {
    count++
    deepest = Math.max(deepest, depth)
    if (count > limits.authoredSteps) {
      throw new WorkLimitError(
        `${roots.join(' and ')} contain ${count} authored Steps; the Work limit is ${limits.authoredSteps}`,
        'authoredSteps',
        count,
        limits.authoredSteps,
        file,
      )
    }
    if (depth > limits.stepDepth) {
      throw new WorkLimitError(
        `${path}: Steps nested more than ${limits.stepDepth} deep, which is deeper than a Recipe can mean`,
        'stepDepth',
        depth,
        limits.stepDepth,
        file,
      )
    }
  })

  return { count, depth: deepest }
}
