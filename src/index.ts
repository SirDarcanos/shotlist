export {
  Config,
  ShotlistError,
  findConfig,
  formatIssues,
  fromRoot,
  loadConfig,
  mergeStyle,
  parseConfig,
  readDocument,
} from './config.js'
export type { LoadedConfig, Serve, Style } from './config.js'

export {
  Macro,
  Recipe,
  VERBS,
  expandSteps,
  interpolate,
  loadLibrary,
  nearestVerb,
  parseRecipe,
  withNumbering,
} from './recipe.js'
export type { Callout, Library, ResolvedStep, StepInput } from './recipe.js'

export {
  ElementQuery,
  Query,
  QUERY_KEYS,
  evaluateQuery,
  resolveQuery,
  aliasKeyOf,
  isAliasCall,
  parseQuery,
  resolveAliases,
  substitute,
} from './query.js'
export type { QueryContext, QueryInput, Rect, Resolved } from './query.js'

export { shoot } from './capture.js'
export type { Retry, ShotResult } from './capture.js'
export { drawAnnotations } from './annotate.js'
export type { AnnotationSpec, Badge, DrawStyle, Mark, Place } from './annotate.js'
export { loadPlaywright } from './playwright.js'
export { runSteps } from './steps.js'
export type { RunContext } from './steps.js'
export { check } from './check.js'
export type { CheckResult } from './check.js'
export {
  BASELINE_FILE,
  baselineFile,
  describeEnvironment,
  environmentDrift,
  readBaseline,
  writeBaseline,
} from './baseline.js'
export type { Drift, Environment } from './baseline.js'
export { startServer, tokenize, withServer } from './serve.js'
export type { Server } from './serve.js'
export { run } from './cli.js'
