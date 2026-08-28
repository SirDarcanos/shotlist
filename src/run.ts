import { ShotlistError, loadConfig } from './config.js'
import type { Config, LoadedConfig } from './config.js'
import { openLibrary } from './library.js'
import type { DeepReadonly, ProjectLibrary } from './library.js'
import type { Recipe } from './recipe.js'
import { compileNetworkPolicy } from './network-policy.js'
import type { NetworkDestination, NetworkPolicy } from './network-policy.js'
import { trustFromEnvironment } from './trust.js'
import type { Trust } from './trust.js'

export type { DeepReadonly, ProjectLibrary } from './library.js'

/** Authority the operator declares before shotlist opens a Project. */
export interface OperatorAuthority {
  /** Apply the restrictions for a Project the operator does not trust. */
  readonly untrusted: boolean
  /** Network destinations the operator grants. */
  readonly destinations?: readonly string[]
  /** Filesystem roots the operator grants in addition to the Project root. */
  readonly paths?: readonly string[]
  /** Path names the operator forbids. */
  readonly deny?: readonly string[]
  /** Environment names the operator grants to recipes. */
  readonly env?: readonly string[]
}

/** A parsed configuration and its complete Library. */
export interface Project {
  readonly config: DeepReadonly<Config>
  readonly root: string
  readonly file: string
  readonly library: ProjectLibrary
}

/** One immutable invocation snapshot under explicit Operator authority. */
export interface Run {
  readonly project: Project
  readonly authority: DeepReadonly<OperatorAuthority>
  readonly trust: DeepReadonly<Trust>
  /** Canonical Operator approvals suitable for human and JSON reports. */
  readonly operatorDestinations: readonly NetworkDestination[]
  /** Allowed environment values captured while the Run opened. */
  readonly env: Readonly<Record<string, string>>
}

/** Policy state shared by Run opening and incomplete Project discovery. */
export interface ProjectPolicy {
  readonly authority: DeepReadonly<OperatorAuthority>
  readonly trust: DeepReadonly<Trust>
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** Full process environment snapshots retained without exposing ungranted values to recipes. */
const ENVIRONMENTS = new WeakMap<Run, Readonly<Record<string, string | undefined>>>()
const NETWORK_POLICIES = new WeakMap<Run, NetworkPolicy>()

/** Refuse a value not created by shotlist's Run opener. */
export function assertRun(value: unknown): asserts value is Run {
  if (typeof value !== 'object' || value === null || !ENVIRONMENTS.has(value as Run)) {
    throw new ShotlistError('A Run opened by shotlist is required')
  }
}

/** Refuse a Recipe that does not belong to the Run. */
export function assertRecipe(run: Run, recipe: DeepReadonly<Recipe>): void {
  assertRun(run)
  if (![...run.project.library.recipes.values()].includes(recipe)) {
    throw new ShotlistError(`Recipe "${recipe.name}" does not belong to this Run`)
  }
}

/** Return the process environment captured for a Run-owned process. */
export function environmentSnapshot(run: Run): Readonly<Record<string, string | undefined>> {
  assertRun(run)
  return ENVIRONMENTS.get(run)!
}

/** Copy and validate an Operator authority declaration from a TypeScript or JavaScript caller. */
function snapshotAuthority(value: unknown): Readonly<OperatorAuthority> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShotlistError('Operator authority is required to open a Run')
  }
  const source = value as Record<string, unknown>
  if (typeof source['untrusted'] !== 'boolean') {
    throw new ShotlistError('Operator authority `untrusted` must be a boolean')
  }

  /** Copy one optional list without retaining the caller's array. */
  const copy = (key: 'destinations' | 'paths' | 'deny' | 'env'): readonly string[] | undefined => {
    const names = source[key]
    if (names === undefined) return undefined
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      throw new ShotlistError(`Operator authority \`${key}\` must be a list of strings`)
    }
    return Object.freeze([...names])
  }

  const destinations = copy('destinations')
  const paths = copy('paths')
  const deny = copy('deny')
  const env = copy('env')
  const authority: OperatorAuthority = {
    untrusted: source['untrusted'],
    ...(destinations !== undefined ? { destinations } : {}),
    ...(paths !== undefined ? { paths } : {}),
    ...(deny !== undefined ? { deny } : {}),
    ...(env !== undefined ? { env } : {}),
  }
  return Object.freeze(authority)
}

/** Validate and copy an Operator authority declaration before any Project effect. */
export function operatorAuthority(value: unknown): DeepReadonly<OperatorAuthority> {
  return snapshotAuthority(value)
}

/** Freeze arrays and plain object graphs built while opening a Run. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== 'object' || value === null) return value as DeepReadonly<T>
  if (seen.has(value)) return value as DeepReadonly<T>
  seen.add(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
  return Object.freeze(value) as DeepReadonly<T>
}

/** Derive immutable policy state from snapshots owned by shotlist. */
function policyFrom(
  authority: DeepReadonly<OperatorAuthority>,
  loaded: LoadedConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ProjectPolicy {
  const config = loaded.config
  const trust = deepFreeze(
    trustFromEnvironment(
      {
        root: loaded.root,
        siteUrl: config.site.url,
        allow: config.site.allow,
        deny: config.deny,
        allowEnv: config.allowEnv,
        granted: {
          paths: authority.paths ?? [],
          deny: authority.deny ?? [],
          env: authority.env ?? [],
        },
      },
      authority.untrusted,
      environment,
    ),
  )
  return Object.freeze({ authority, trust, environment })
}

/** Derive immutable policy state for a loaded Project under explicit Operator authority. */
export function projectPolicy(
  authorityValue: OperatorAuthority,
  loaded: LoadedConfig,
): ProjectPolicy {
  return policyFrom(operatorAuthority(authorityValue), loaded, Object.freeze({ ...process.env }))
}

/** Return the private Network destination policy owned by an authentic Run. */
export function networkPolicyFor(run: Run): NetworkPolicy {
  assertRun(run)
  return NETWORK_POLICIES.get(run)!
}

/** Turn a Project site URL into the destination approval it names. */
function siteDestination(siteUrl: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(siteUrl)
  } catch {
    throw new ShotlistError('site.url must name an http(s) Network destination')
  }
  if (parsed.username || parsed.password) {
    throw new ShotlistError('site.url must not contain a username or password')
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.port === '0') {
    return undefined
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ShotlistError(
      'site.url must use http, https, data, or blob for an Application Recipe',
    )
  }
  return parsed.origin
}

/** Network destinations a trusted Project declares through its site settings. */
function projectDestinations(config: Config): string[] {
  const ready = config.site.serve?.ready
  return [
    siteDestination(config.site.url),
    ...config.site.allow,
    ...(typeof ready === 'string' && /^https?:\/\//.test(ready)
      ? [siteDestination(ready)]
      : typeof ready === 'number'
        ? [`tcp://127.0.0.1:${ready}`]
        : []),
  ].filter((destination): destination is string => destination !== undefined)
}

/** Operator destinations granted by protected process settings. */
function destinationsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  return (environment['SHOTLIST_ALLOW'] ?? '')
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

/** Open a complete immutable Run after authorizing its config-directed Library reads. */
export function openRun(authorityValue: OperatorAuthority, configFile?: string): Run {
  const authority = operatorAuthority(authorityValue)
  const environment = Object.freeze({ ...process.env })
  const loaded = loadConfig(configFile)
  const config = loaded.config
  const { trust } = policyFrom(authority, loaded, environment)

  const network = compileNetworkPolicy({
    operator: [...(authority.destinations ?? []), ...destinationsFromEnvironment(environment)],
    project: authority.untrusted ? [] : projectDestinations(config),
    untrusted: authority.untrusted,
    deny: trust.deny,
  })
  const library = openLibrary(loaded, trust)
  const project = Object.freeze({
    config: deepFreeze(config),
    root: loaded.root,
    file: loaded.file,
    library,
  })
  const env = Object.freeze(
    Object.fromEntries(
      trust.env.flatMap((name) => {
        const value = environment[name]
        return value === undefined || value === '' ? [] : [[name, value]]
      }),
    ),
  )
  const run = Object.freeze({
    project,
    authority,
    trust,
    operatorDestinations: network.operatorDestinations,
    env,
  })
  ENVIRONMENTS.set(run, environment)
  NETWORK_POLICIES.set(run, network)
  return run
}
