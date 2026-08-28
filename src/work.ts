import { ShotlistError } from './config.js'

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
