import { basename, join } from 'node:path'
import { ShotlistError, fromRoot, loadConfig, readDocumentAt } from './config.js'
import type { Config, LoadedConfig } from './config.js'
import { documentFiles, parseLibrary } from './recipe.js'
import type { Library, LibraryDocument, Macro, Recipe } from './recipe.js'
import { authorizePath, trustFromEnvironment } from './trust.js'
import type { Trust } from './trust.js'

/** A value whose nested arrays, mappings, and fields cannot change through the Run. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends readonly (infer V)[]
      ? readonly DeepReadonly<V>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T

/** Authority the operator declares before shotlist opens a Project. */
export interface OperatorAuthority {
  /** Apply the restrictions for a Project the operator does not trust. */
  readonly untrusted: boolean
  /** Hosts the operator grants in addition to the Project's site. */
  readonly hosts?: readonly string[]
  /** Filesystem roots the operator grants in addition to the Project root. */
  readonly paths?: readonly string[]
  /** Path names the operator forbids. */
  readonly deny?: readonly string[]
  /** Environment names the operator grants to recipes. */
  readonly env?: readonly string[]
}

/** The immutable Library view exposed by a Run. */
export interface ProjectLibrary {
  readonly recipes: ReadonlyMap<string, DeepReadonly<Recipe>>
  readonly macros: ReadonlyMap<string, DeepReadonly<Macro>>
  readonly data: DeepReadonly<Record<string, unknown>>
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
  const copy = (key: 'hosts' | 'paths' | 'deny' | 'env'): readonly string[] | undefined => {
    const names = source[key]
    if (names === undefined) return undefined
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      throw new ShotlistError(`Operator authority \`${key}\` must be a list of strings`)
    }
    return Object.freeze([...names])
  }

  const hosts = copy('hosts')
  const paths = copy('paths')
  const deny = copy('deny')
  const env = copy('env')
  const authority: OperatorAuthority = {
    untrusted: source['untrusted'],
    ...(hosts !== undefined ? { hosts } : {}),
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

/** A Map view with no mutation methods or exposed backing Map. */
class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>

  /** Copy entries into an inaccessible backing Map. */
  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries)
    Object.freeze(this)
  }

  /** Report the number of entries. */
  get size(): number {
    return this.#values.size
  }

  /** Return the value for a key. */
  get(key: K): V | undefined {
    return this.#values.get(key)
  }

  /** Report whether a key exists. */
  has(key: K): boolean {
    return this.#values.has(key)
  }

  /** Iterate over key-value pairs. */
  entries(): MapIterator<[K, V]> {
    return this.#values.entries()
  }

  /** Iterate over keys. */
  keys(): MapIterator<K> {
    return this.#values.keys()
  }

  /** Iterate over values. */
  values(): MapIterator<V> {
    return this.#values.values()
  }

  /** Call a function for each entry. */
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this)
  }

  /** Iterate over key-value pairs. */
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }
}

/** Freeze a parsed Library behind runtime read-only views. */
function freezeLibrary(library: Library): ProjectLibrary {
  const recipes = new ImmutableMap(
    [...library.recipes].map(([name, recipe]) => [name, deepFreeze(recipe)] as const),
  )
  const macros = new ImmutableMap(
    [...library.macros].map(([name, macro]) => [name, deepFreeze(macro)] as const),
  )
  return Object.freeze({ recipes, macros, data: deepFreeze(library.data) })
}

type LibraryKind = 'macros' | 'data' | 'recipes'

interface PendingDocument {
  kind: LibraryKind
  document: LibraryDocument
  target: string
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
          hosts: authority.hosts ?? [],
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

/** Open a complete immutable Run after authorizing its config-directed Library reads. */
export function openRun(authorityValue: OperatorAuthority, configFile?: string): Run {
  const authority = operatorAuthority(authorityValue)
  const environment = Object.freeze({ ...process.env })
  const loaded = loadConfig(configFile)
  const config = loaded.config
  const { trust } = policyFrom(authority, loaded, environment)

  const directories = (['macros', 'data', 'recipes'] as const).map((kind) => {
    const authored = fromRoot(loaded, config.paths[kind])
    return {
      kind,
      authored,
      target: authorizePath(trust, authored, `paths.${kind}`),
    }
  })

  // Authorize every discovered entry before reading any of them. An entry may be a
  // symlink even after its containing directory passed policy.
  const pending: PendingDocument[] = directories.flatMap(({ kind, authored, target }) =>
    documentFiles(target).map(({ name, file }) => ({
      kind,
      target: authorizePath(trust, file, `paths.${kind}`),
      document: { name, file: join(authored, basename(file)), raw: undefined },
    })),
  )

  const documents: Record<LibraryKind, LibraryDocument[]> = {
    macros: [],
    data: [],
    recipes: [],
  }
  for (const pendingDocument of pending) {
    const { kind, target, document } = pendingDocument
    documents[kind].push({
      ...document,
      raw: readDocumentAt(target, document.file),
    })
  }

  const library = freezeLibrary(parseLibrary(documents, config.finders))
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
  const run = Object.freeze({ project, authority, trust, env })
  ENVIRONMENTS.set(run, environment)
  return run
}
