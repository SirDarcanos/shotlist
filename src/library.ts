import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ShotlistError, fromRoot, parseDocumentText } from './config.js'
import type { LoadedConfig } from './config.js'
import { parseMacro, parseRecipe, withNumbering } from './recipe.js'
import type { Macro, Recipe } from './recipe.js'
import { authorizePath } from './trust.js'
import type { Trust } from './trust.js'
import {
  DEFAULT_WORK_LIMITS,
  WorkLimitError,
  authoredWork,
  matchingMeasurementsIn,
  nearWorkLimit,
  preflightLibrary,
  preflightMacro,
  preflightRecipe,
  validateMatchingIn,
} from './work-limit.js'
import type { WorkLimits } from './work-limit.js'

const DOCUMENTS = new Set(['.yaml', '.yml', '.json'])

type LibraryKind = 'macros' | 'data' | 'recipes'

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends readonly (infer V)[]
      ? readonly DeepReadonly<V>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T

export interface Library {
  recipes: Map<string, Recipe>
  macros: Map<string, Macro>
  data: Record<string, unknown>
}

/** The immutable Library view exposed by a Run. */
export interface ProjectLibrary {
  readonly recipes: ReadonlyMap<string, DeepReadonly<Recipe>>
  readonly macros: ReadonlyMap<string, DeepReadonly<Macro>>
  readonly data: DeepReadonly<Record<string, unknown>>
}

export interface LibraryDocument {
  name: string
  /** The authored path used in diagnostics, which may name a symlink. */
  file: string
  raw: unknown
}

export interface LibraryDocuments {
  recipes: readonly LibraryDocument[]
  macros: readonly LibraryDocument[]
  data: readonly LibraryDocument[]
}

/** Parse a complete set of already-read Library documents. */
export function parseLibrary(
  documents: LibraryDocuments,
  finders: Readonly<Record<string, unknown>> = {},
  workLimits: Readonly<WorkLimits> = DEFAULT_WORK_LIMITS,
): Library {
  const macros = new Map<string, Macro>()
  for (const { name, file, raw } of documents.macros) {
    const macro = parseMacro(raw, { finders, file, workLimits })
    macros.set(macro.name ?? name, macro)
  }

  const data: Record<string, unknown> = {}
  for (const { name, raw } of documents.data) {
    // Assignment treats `__proto__` as a prototype setter rather than a document name.
    Object.defineProperty(data, name, {
      value: raw,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }

  const recipes = new Map<string, Recipe>()
  for (const { name, file, raw } of documents.recipes) {
    const recipe = withNumbering(parseRecipe(raw, { finders, file, name, workLimits }))
    recipes.set(recipe.name!, recipe)
  }

  const library = { recipes, macros, data }
  preflightLibrary(library, workLimits)
  return library
}

/** One problem found while reviewing an incomplete Library. */
export interface LibraryProblem {
  file: string
  message: string
  /** An error refuses the document; a warning is legal but probably not meant. */
  level: 'error' | 'warning'
}

export interface LibraryReviewOptions {
  warnings?: boolean
}

/** Problems and document count observed in one Library traversal. */
export interface LibraryReview {
  readonly problems: readonly LibraryProblem[]
  /** Discovered Library documents, including documents refused after enumeration. */
  readonly documents: number
}

type PreparedDirectory =
  | { kind: LibraryKind; file: string; target: string }
  | { kind: LibraryKind; file: string; stage: 'authorization'; error: unknown }

type PreparedDocument =
  { name: string; file: string; target: string } | { name: string; file: string; error: unknown }

type PreparedGroup =
  | { kind: LibraryKind; file: string; documents: readonly PreparedDocument[] }
  | {
      kind: LibraryKind
      file: string
      documents: readonly []
      stage: 'authorization' | 'enumeration'
      error: unknown
    }

/** Replace a private authorized target with the path the Project author wrote. */
function authoredError(error: unknown, target: string, file: string): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes(target)) return error
  return new ShotlistError(message.split(target).join(file))
}

/** List supported document filenames in stable order. */
function documentFiles(dir: string): Array<{ name: string; file: string }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => DOCUMENTS.has(extname(entry)) && !entry.startsWith('.'))
    .sort()
    .map((entry) => ({ name: basename(entry, extname(entry)), file: join(dir, entry) }))
}

/** Prepare every policy-aware Library read without exposing an authorized target. */
function prepareLibrary(loaded: LoadedConfig, trust: Trust): readonly PreparedGroup[] {
  const kinds: readonly LibraryKind[] = ['macros', 'data', 'recipes']
  // Authorize every directory before enumerating one, so Run opening never observes a
  // malformed document before a later configured directory is refused.
  const directories: PreparedDirectory[] = kinds.map((kind) => {
    const file = fromRoot(loaded, loaded.config.paths[kind])
    try {
      return { kind, file, target: authorizePath(trust, file, `paths.${kind}`) }
    } catch (error) {
      return { kind, file, stage: 'authorization', error }
    }
  })

  return Object.freeze(
    directories.map((directory): PreparedGroup => {
      if ('error' in directory) return Object.freeze({ ...directory, documents: [] })
      try {
        const documents = Object.freeze(
          documentFiles(directory.target).map(({ name, file: target }): PreparedDocument => {
            const file = join(directory.file, basename(target))
            try {
              return Object.freeze({
                name,
                file,
                target: authorizePath(trust, target, `paths.${directory.kind}`),
              })
            } catch (error) {
              return Object.freeze({ name, file, error: authoredError(error, target, file) })
            }
          }),
        )
        return Object.freeze({ kind: directory.kind, file: directory.file, documents })
      } catch (error) {
        return Object.freeze({
          kind: directory.kind,
          file: directory.file,
          documents: [],
          stage: 'enumeration',
          error: authoredError(error, directory.target, directory.file),
        })
      }
    }),
  )
}

/** Freeze arrays and plain object graphs assembled for a Library. */
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

/** Publish a parsed Library through runtime read-only views. */
function freezeLibrary(library: Library): ProjectLibrary {
  const recipes = new ImmutableMap(
    [...library.recipes].map(([name, recipe]) => [name, deepFreeze(recipe)] as const),
  )
  const macros = new ImmutableMap(
    [...library.macros].map(([name, macro]) => [name, deepFreeze(macro)] as const),
  )
  return Object.freeze({ recipes, macros, data: deepFreeze(library.data) })
}

/** Read one Library document through the Work limit before parsing its text. */
function readPreparedDocument(
  document: { file: string; target: string },
  kind: LibraryKind,
  workLimits: Readonly<WorkLimits>,
): { raw: unknown; bytes: number; limitName: 'recipeBytes' | 'macroBytes' | 'dataBytes' } {
  const limitName =
    kind === 'recipes' ? 'recipeBytes' : kind === 'macros' ? 'macroBytes' : 'dataBytes'
  const allowed = workLimits[limitName]
  const chunks: Buffer[] = []
  let bytes = 0
  let descriptor: number | undefined
  try {
    descriptor = openSync(document.target, 'r')
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, allowed - bytes + 1))
      const read = readSync(descriptor, chunk, 0, chunk.length, null)
      if (!read) break
      bytes += read
      if (bytes > allowed) {
        const label = kind === 'recipes' ? 'Recipe' : kind === 'macros' ? 'Macro' : 'Data document'
        throw new WorkLimitError(
          `${label} is larger than ${allowed} bytes; the Work limit is ${allowed}`,
          limitName,
          bytes,
          allowed,
          document.file,
        )
      }
      chunks.push(chunk.subarray(0, read))
    }
    return {
      raw: parseDocumentText(Buffer.concat(chunks, bytes).toString('utf8'), document.file),
      bytes,
      limitName,
    }
  } catch (error) {
    throw authoredError(error, document.target, document.file)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Read and publish one complete immutable Library, or expose none of it. */
export function openLibrary(
  loaded: LoadedConfig,
  trust: Trust,
  workLimits: Readonly<WorkLimits> = DEFAULT_WORK_LIMITS,
): ProjectLibrary {
  try {
    validateMatchingIn(loaded.config.finders, workLimits.matchingCharacters)
  } catch (error) {
    throw new ShotlistError((error as Error).message, loaded.file)
  }
  const groups = prepareLibrary(loaded, trust)
  for (const group of groups) {
    if ('error' in group && group.stage === 'authorization') throw group.error
  }
  for (const group of groups) {
    if ('error' in group) throw group.error
    for (const document of group.documents) {
      if ('error' in document) throw document.error
    }
  }

  const documents: Record<LibraryKind, LibraryDocument[]> = {
    macros: [],
    data: [],
    recipes: [],
  }
  // Read every document before parsing one, so syntax failures retain their precedence
  // over language failures in documents that sorted before them.
  for (const group of groups) {
    if ('error' in group) throw group.error
    for (const document of group.documents) {
      if ('error' in document) throw document.error
      documents[group.kind].push({
        name: document.name,
        file: document.file,
        raw: readPreparedDocument(document, group.kind, workLimits).raw,
      })
    }
  }
  return freezeLibrary(parseLibrary(documents, loaded.config.finders, workLimits))
}

/** What a thrown failure says without the filename the review already carries. */
function said(error: unknown, file: string): string {
  const message = error instanceof ShotlistError ? error.message : String(error)
  const withoutFile = message.startsWith(`${file}: `) ? message.slice(file.length + 2) : message
  return withoutFile.replace(/^invalid (?:recipe|macro|config) —\n\s*/, '')
}

/** Report legal Recipe relationships that are probably not intended. */
function suspect(recipe: Recipe, loaded: LoadedConfig): string[] {
  const found: string[] = []
  const pointedAt = new Set(recipe.callouts.map((callout) => callout.mark))
  for (const name of Object.keys(recipe.marks)) {
    if (!pointedAt.has(name)) found.push(`mark "${name}" is never used by a callout`)
  }
  for (const callout of recipe.callouts) {
    if (!(callout.mark in recipe.marks)) {
      found.push(`callout points at "${callout.mark}", which no mark defines`)
    }
  }
  if (recipe.install !== undefined && !(recipe.install in loaded.config.install)) {
    found.push(`install: "${recipe.install}" is not a destination the config names`)
  }
  if (recipe.session !== undefined && !(recipe.session in loaded.config.site.sessions)) {
    found.push(`session: "${recipe.session}" is not a session the config names`)
  }
  return found
}

/** Review every reachable Library document and retain all countable outcomes. */
export function reviewLibrary(
  loaded: LoadedConfig,
  trust: Trust,
  options: LibraryReviewOptions = {},
  workLimits: Readonly<WorkLimits> = DEFAULT_WORK_LIMITS,
): LibraryReview {
  const problems: LibraryProblem[] = []
  try {
    validateMatchingIn(loaded.config.finders, workLimits.matchingCharacters)
    for (const matching of matchingMeasurementsIn(loaded.config.finders)) {
      if (nearWorkLimit(matching.characters, workLimits.matchingCharacters)) {
        problems.push({
          file: loaded.file,
          level: 'warning',
          message: `finders.${matching.path} has ${matching.characters} matching characters; the Work limit is ${workLimits.matchingCharacters}`,
        })
      }
    }
  } catch (error) {
    problems.push({ file: loaded.file, level: 'error', message: (error as Error).message })
  }
  const groups = prepareLibrary(loaded, trust)
  const reviewLibrary: Library = { recipes: new Map(), macros: new Map(), data: {} }
  const recipeFiles = new Map<string, string>()
  const macroFiles = new Map<string, string>()
  let documents = 0

  for (const group of groups) {
    documents += group.documents.length
    if ('error' in group) {
      problems.push({ file: group.file, message: said(group.error, group.file), level: 'error' })
      continue
    }
    for (const document of group.documents) {
      const { file } = document
      if ('error' in document) {
        problems.push({ file, message: said(document.error, file), level: 'error' })
        continue
      }
      try {
        const read = readPreparedDocument(document, group.kind, workLimits)
        const { raw } = read
        if (nearWorkLimit(read.bytes, workLimits[read.limitName])) {
          problems.push({
            file,
            level: 'warning',
            message: `${read.bytes} bytes approach the Work limit of ${workLimits[read.limitName]}`,
          })
        }
        if (group.kind === 'macros') {
          const macro = parseMacro(raw, { finders: loaded.config.finders, file, workLimits })
          const name = macro.name ?? document.name
          reviewLibrary.macros.set(name, macro)
          macroFiles.set(name, file)
          const measured = authoredWork(raw, ['steps'], workLimits, file)
          if (nearWorkLimit(measured.count, workLimits.authoredSteps)) {
            problems.push({
              file,
              level: 'warning',
              message: `${measured.count} authored Steps approach the Work limit of ${workLimits.authoredSteps}`,
            })
          }
          if (nearWorkLimit(measured.depth, workLimits.stepDepth)) {
            problems.push({
              file,
              level: 'warning',
              message: `Step nesting of ${measured.depth} approaches the Work limit of ${workLimits.stepDepth}`,
            })
          }
          for (const matching of matchingMeasurementsIn(raw)) {
            if (nearWorkLimit(matching.characters, workLimits.matchingCharacters)) {
              problems.push({
                file,
                level: 'warning',
                message: `${matching.path} has ${matching.characters} matching characters; the Work limit is ${workLimits.matchingCharacters}`,
              })
            }
          }
        } else if (group.kind === 'recipes') {
          const recipe = withNumbering(
            parseRecipe(raw, {
              finders: loaded.config.finders,
              file,
              name: document.name,
              workLimits,
            }),
          )
          reviewLibrary.recipes.set(recipe.name!, recipe)
          recipeFiles.set(recipe.name!, file)
          const measured = authoredWork(raw, ['setup', 'teardown'], workLimits, file)
          if (nearWorkLimit(measured.count, workLimits.authoredSteps)) {
            problems.push({
              file,
              level: 'warning',
              message: `${measured.count} authored Steps approach the Work limit of ${workLimits.authoredSteps}`,
            })
          }
          if (nearWorkLimit(measured.depth, workLimits.stepDepth)) {
            problems.push({
              file,
              level: 'warning',
              message: `Step nesting of ${measured.depth} approaches the Work limit of ${workLimits.stepDepth}`,
            })
          }
          for (const matching of matchingMeasurementsIn(raw)) {
            if (nearWorkLimit(matching.characters, workLimits.matchingCharacters)) {
              problems.push({
                file,
                level: 'warning',
                message: `${matching.path} has ${matching.characters} matching characters; the Work limit is ${workLimits.matchingCharacters}`,
              })
            }
          }
          if (options.warnings) {
            for (const message of suspect(recipe, loaded)) {
              problems.push({ file, message, level: 'warning' })
            }
          }
        } else {
          Object.defineProperty(reviewLibrary.data, document.name, {
            value: raw,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        }
      } catch (error) {
        problems.push({ file, message: said(error, file), level: 'error' })
      }
    }
  }

  for (const name of reviewLibrary.macros.keys()) {
    const file = macroFiles.get(name)!
    try {
      const measured = preflightMacro(name, reviewLibrary, workLimits)
      const checks: Array<[number, number, string]> = [
        [measured.expanded, workLimits.expandedSteps, 'expanded Steps'],
        [measured.executed, workLimits.executedSteps, 'predictable Steps'],
        [measured.milliseconds, workLimits.recipeMilliseconds, 'predictable wait milliseconds'],
        [measured.eachItems, workLimits.eachItems, 'each items'],
        [measured.macroDepth, workLimits.macroDepth, 'Macro depth'],
      ]
      for (const [observed, allowed, label] of checks) {
        if (nearWorkLimit(observed, allowed)) {
          problems.push({
            file,
            level: 'warning',
            message: `${label}: ${observed} approaches the Work limit of ${allowed}`,
          })
        }
      }
    } catch (error) {
      problems.push({ file, message: said(error, file), level: 'error' })
    }
  }

  for (const [name, recipe] of reviewLibrary.recipes) {
    const file = recipeFiles.get(name)!
    try {
      const measured = preflightRecipe(name, recipe, reviewLibrary, workLimits)
      const checks: Array<[number, number, string]> = [
        [measured.setup.expanded, workLimits.expandedSteps, 'expanded Steps'],
        [measured.setup.executed, workLimits.executedSteps, 'predictable Steps'],
        [
          measured.setup.milliseconds,
          workLimits.recipeMilliseconds,
          'predictable wait milliseconds',
        ],
        [measured.setup.eachItems, workLimits.eachItems, 'each items'],
        [measured.setup.macroDepth, workLimits.macroDepth, 'Macro depth'],
        [measured.teardown.expanded, workLimits.expandedSteps, 'expanded teardown Steps'],
        [measured.teardown.executed, workLimits.teardownSteps, 'predictable teardown Steps'],
        [
          measured.teardown.milliseconds,
          workLimits.teardownMilliseconds,
          'predictable teardown wait milliseconds',
        ],
      ]
      for (const [observed, allowed, label] of checks) {
        if (nearWorkLimit(observed, allowed)) {
          problems.push({
            file,
            level: 'warning',
            message: `${label}: ${observed} approaches the Work limit of ${allowed}`,
          })
        }
      }
    } catch (error) {
      problems.push({ file, message: said(error, file), level: 'error' })
    }
  }

  return Object.freeze({ problems: Object.freeze(problems), documents })
}

/** Count documents found through policy-aware Library discovery without reading them. */
export function countLibraryDocuments(loaded: LoadedConfig, trust: Trust): number {
  return prepareLibrary(loaded, trust).reduce((total, group) => total + group.documents.length, 0)
}
