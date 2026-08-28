import { ShotlistError } from './config.js'
import { MAX_MATCHING_CHARACTERS, validateMatchingIn } from './matching.js'
export {
  MAX_MATCHING_CHARACTERS,
  matchingMeasurementsIn,
  validateMatching,
  validateMatchingIn,
} from './matching.js'

/** Numerical ceilings owned by the Operator for one Run. */
export interface WorkLimits {
  readonly recipeBytes: number
  readonly macroBytes: number
  readonly dataBytes: number
  readonly authoredSteps: number
  readonly stepDepth: number
  readonly macroDepth: number
  readonly expandedSteps: number
  readonly executedSteps: number
  readonly eachItems: number
  readonly matchingCharacters: number
  readonly recipeMilliseconds: number
  readonly teardownSteps: number
  readonly teardownMilliseconds: number
}

export type WorkLimitName = keyof WorkLimits
export type WorkLimitOverrides = Readonly<Partial<WorkLimits>>

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

/** The Work allowance used by one attempt, teardown, or scripted sign-in. */
export interface StepWork {
  readonly signal?: AbortSignal
  /** Count one Step immediately before its implementation starts. */
  step(): void
  /** Refuse an interpolated each list before its first item runs. */
  each(items: number): void
  /** Recheck matching patterns revealed by interpolation. */
  matching(value: unknown): void
  /** Race one effect against the phase deadline and stop its owner when time expires. */
  run<T>(operation: () => Promise<T>, stop?: () => Promise<void>): Promise<T>
}

interface WorkDeadline {
  readonly signal: AbortSignal
  readonly error: WorkLimitError
  readonly expiresAt: number
}

/** Create one actual-Step meter for an attempt, teardown, or scripted sign-in. */
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

/** A Work limit failure that deterministic Recipe retries cannot repair. */
export class WorkLimitError extends ShotlistError {
  readonly code = 'SHOTLIST_WORK_LIMIT'

  constructor(
    readonly detail: string,
    readonly limit: WorkLimitName,
    readonly observed: number,
    readonly allowed: number,
    file?: string,
    readonly raiseable = true,
  ) {
    super(
      raiseable
        ? `${detail}. The Operator may raise it with --work-limit ${limit}=<number>.`
        : detail,
      file,
    )
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
  readonly steps: readonly unknown[]
}

interface WorkRecipe {
  readonly name?: string
  readonly setup: readonly unknown[]
  readonly teardown: readonly unknown[]
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

/** Resolve one whole-value reference while planning known Data document loops. */
function knownValue(value: unknown, scope: Readonly<Record<string, unknown>>): unknown {
  if (typeof value !== 'string') return value
  const matched = /^\$\{?([A-Za-z_][\w.]*)\}?$/.exec(value)
  if (!matched) return value
  let current: unknown = scope
  for (const key of matched[1]!.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current === value ? undefined : knownValue(current, scope)
}

/** Saturate multiplied work before JavaScript loses integer precision. */
function boundedArithmetic(value: number, _limit: number): number {
  return Math.min(value, Number.MAX_SAFE_INTEGER)
}

/** Calculate expanded and predictable executed Steps without constructing their expansion. */
function planSteps(
  steps: readonly unknown[],
  library: WorkLibrary,
  limits: Readonly<WorkLimits>,
  scope: Readonly<Record<string, unknown>>,
  seen: readonly string[] = [],
  executionLimit = limits.executedSteps,
  timeLimit = limits.recipeMilliseconds,
): PlannedWork {
  let expanded = 0
  let executed = 0
  let milliseconds = 0
  let eachItems = 0
  let macroDepth = seen.length
  const measured = (): PlannedWork => ({ expanded, executed, milliseconds, eachItems, macroDepth })
  const exceeded = () =>
    expanded > limits.expandedSteps || executed > executionLimit || milliseconds > timeLimit

  for (const raw of steps) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const step = raw as Record<string, unknown>
    if (typeof step['use'] === 'string') {
      const name = step['use']
      const macro = library.macros.get(name)
      if (!macro) throw new ShotlistError(`unknown macro "${name}"`)
      if (seen.includes(name)) {
        throw new ShotlistError(`macro "${name}" uses itself (${[...seen, name].join(' → ')})`)
      }
      if (seen.length + 1 > limits.macroDepth) {
        throw new WorkLimitError(
          `Macro expansion is more than ${limits.macroDepth} deep; the Work limit is ${limits.macroDepth}`,
          'macroDepth',
          seen.length + 1,
          limits.macroDepth,
        )
      }
      const withValues =
        typeof step['with'] === 'object' && step['with'] !== null
          ? (step['with'] as Record<string, unknown>)
          : {}
      const nested = planSteps(
        macro.steps,
        library,
        limits,
        { ...scope, ...macro.defaults, ...withValues },
        [...seen, name],
        executionLimit,
        timeLimit,
      )
      expanded = boundedArithmetic(expanded + nested.expanded, limits.expandedSteps)
      executed = boundedArithmetic(executed + nested.executed, limits.executedSteps)
      milliseconds = boundedArithmetic(milliseconds + nested.milliseconds, timeLimit)
      eachItems = Math.max(eachItems, nested.eachItems)
      macroDepth = Math.max(macroDepth, nested.macroDepth)
      if (exceeded()) return measured()
      continue
    }

    expanded = boundedArithmetic(expanded + 1, limits.expandedSteps)
    executed = boundedArithmetic(executed + 1, limits.executedSteps)
    if (typeof step['wait'] === 'number') {
      milliseconds = boundedArithmetic(milliseconds + step['wait'], timeLimit)
    }
    if (exceeded()) return measured()
    const nested = Array.isArray(step['steps'])
      ? step['steps']
      : Array.isArray(step['optional'])
        ? step['optional']
        : undefined
    if (!nested) continue

    if (typeof step['repeat'] === 'number') {
      const planned = planSteps(nested, library, limits, scope, seen, executionLimit, timeLimit)
      expanded = boundedArithmetic(expanded + planned.expanded, limits.expandedSteps)
      executed = boundedArithmetic(
        executed + planned.executed * step['repeat'],
        limits.executedSteps,
      )
      milliseconds = boundedArithmetic(
        milliseconds + planned.milliseconds * step['repeat'],
        timeLimit,
      )
      eachItems = Math.max(eachItems, planned.eachItems)
      macroDepth = Math.max(macroDepth, planned.macroDepth)
      if (exceeded()) return measured()
      continue
    }

    if (step['each'] !== undefined) {
      const items = knownValue(step['each'], scope)
      if (!Array.isArray(items)) continue
      if (items.length > limits.eachItems) {
        throw new WorkLimitError(
          `each would process ${items.length} items; the Work limit is ${limits.eachItems}`,
          'eachItems',
          items.length,
          limits.eachItems,
        )
      }
      eachItems = Math.max(eachItems, items.length)
      const name = typeof step['as'] === 'string' ? step['as'] : 'item'
      let nestedExpanded = 0
      let nestedExecuted = 0
      let nestedMilliseconds = 0
      for (const item of items) {
        const planned = planSteps(
          nested,
          library,
          limits,
          { ...scope, [name]: item },
          seen,
          executionLimit,
          timeLimit,
        )
        nestedExpanded = Math.max(nestedExpanded, planned.expanded)
        nestedExecuted = boundedArithmetic(nestedExecuted + planned.executed, limits.executedSteps)
        nestedMilliseconds = boundedArithmetic(nestedMilliseconds + planned.milliseconds, timeLimit)
        eachItems = Math.max(eachItems, planned.eachItems)
        macroDepth = Math.max(macroDepth, planned.macroDepth)
        if (
          nestedExpanded > limits.expandedSteps ||
          nestedExecuted > executionLimit ||
          nestedMilliseconds > timeLimit
        ) {
          break
        }
      }
      if (!items.length) {
        const planned = planSteps(nested, library, limits, scope, seen, executionLimit, timeLimit)
        nestedExpanded = planned.expanded
        eachItems = Math.max(eachItems, planned.eachItems)
        macroDepth = Math.max(macroDepth, planned.macroDepth)
      }
      expanded = boundedArithmetic(expanded + nestedExpanded, limits.expandedSteps)
      executed = boundedArithmetic(executed + nestedExecuted, limits.executedSteps)
      milliseconds = boundedArithmetic(milliseconds + nestedMilliseconds, timeLimit)
      if (exceeded()) return measured()
      continue
    }

    const planned = planSteps(nested, library, limits, scope, seen, executionLimit, timeLimit)
    expanded = boundedArithmetic(expanded + planned.expanded, limits.expandedSteps)
    executed = boundedArithmetic(executed + planned.executed, limits.executedSteps)
    milliseconds = boundedArithmetic(milliseconds + planned.milliseconds, timeLimit)
    eachItems = Math.max(eachItems, planned.eachItems)
    macroDepth = Math.max(macroDepth, planned.macroDepth)
    if (exceeded()) return measured()
  }

  return measured()
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
    [],
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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { count: 0, depth: 0 }
  const document = raw as Record<string, unknown>
  const pending: Array<{ value: unknown; depth: number; path: string }> = roots.flatMap((root) => {
    const value = document[root]
    return Array.isArray(value) ? [{ value, depth: 1, path: root }] : []
  })
  let count = 0
  let deepest = 0

  while (pending.length) {
    const current = pending.pop()!
    if (!Array.isArray(current.value)) continue
    for (let index = 0; index < current.value.length; index++) {
      const step = current.value[index]
      const path = `${current.path}[${index}]`
      count++
      deepest = Math.max(deepest, current.depth)
      if (count > limits.authoredSteps) {
        throw new WorkLimitError(
          `${roots.join(' and ')} contain ${count} authored Steps; the Work limit is ${limits.authoredSteps}`,
          'authoredSteps',
          count,
          limits.authoredSteps,
          file,
        )
      }
      if (current.depth > limits.stepDepth) {
        throw new WorkLimitError(
          `${path}: Steps nested more than ${limits.stepDepth} deep, which is deeper than a Recipe can mean`,
          'stepDepth',
          current.depth,
          limits.stepDepth,
          file,
        )
      }
      if (typeof step !== 'object' || step === null || Array.isArray(step)) continue
      const mapping = step as Record<string, unknown>
      for (const nested of ['steps', 'optional']) {
        if (Array.isArray(mapping[nested])) {
          pending.push({
            value: mapping[nested],
            depth: current.depth + 1,
            path: `${path}.${nested}`,
          })
        }
      }
    }
  }

  return { count, depth: deepest }
}
