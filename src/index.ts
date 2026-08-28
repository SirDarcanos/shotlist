export { Config, ShotlistError, formatIssues, mergeStyle, nearest, parseConfig } from './config.js'
export type { Serve, Style } from './config.js'

export {
  Macro,
  Recipe,
  VERBS,
  expandSteps,
  interpolate,
  nearestVerb,
  parseMacro,
  parseRecipe,
  withNumbering,
} from './recipe.js'
export type { Callout, ResolvedStep, StepInput } from './recipe.js'
export { parseLibrary } from './library.js'
export type { Library } from './library.js'

export {
  ElementQuery,
  Query,
  QUERY_KEYS,
  evaluateQuery,
  resolveQuery,
  aliasKeyOf,
  isAliasCall,
  MAX_QUERY_DEPTH,
  parseQuery,
  refuseDeepNesting,
  resolveAliases,
  substitute,
} from './query.js'
export type { QueryContext, QueryInput, Rect, Resolved } from './query.js'

export { FORMATS, MEDIA, extensionOf, formatOf, isLossless, sizeOf } from './image.js'
export type { Format } from './image.js'
export { shoot } from './capture.js'
export type { Retry, ShootOptions, ShotResult } from './capture.js'
export { drawAnnotations } from './annotate.js'
export type { AnnotationSpec, Badge, DrawStyle, Mark, Place } from './annotate.js'
export { loadPlaywright } from './playwright.js'
export { check } from './check.js'
export type { CheckOptions, CheckResult } from './check.js'
export {
  BASELINE_FILE,
  baselineFile,
  describeEnvironment,
  environmentDrift,
  readBaseline,
  writeBaseline,
} from './baseline.js'
export type { Drift, Environment } from './baseline.js'
export { openRun } from './run.js'
export type { DeepReadonly, OperatorAuthority, Project, ProjectLibrary, Run } from './run.js'
export type {
  CaptureRecipeResult,
  CaptureReport,
  CaptureRequest,
  CaptureResourceFailure,
  CaptureSelection,
  CapturedRecipeResult,
  FailedCaptureResult,
  UnattemptedCaptureResult,
} from './execute.js'
export { readSession, signIn } from './session.js'
export type { SignInOptions } from './session.js'
export { startServer, tokenize, withServer } from './serve.js'
export type { Server } from './serve.js'
export { countDocuments, formatProblems, lint } from './lint.js'
export type { LintOptions, Problem } from './lint.js'
export { SCHEMA_FILES } from './schemas.js'
export {
  DEFAULT_WORK_LIMITS,
  MAX_MATCHING_CHARACTERS,
  MAX_STEP_DEPTH,
  WorkLimitError,
  resolveWorkLimits,
  validateMatching,
} from './work-limit.js'
export type { WorkLimitName, WorkLimitOverrides, WorkLimits } from './work-limit.js'
