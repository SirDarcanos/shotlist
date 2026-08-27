import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fromRoot, readDocumentAt } from './config.js'
import type { LoadedConfig } from './config.js'
import { parseMacro, parseRecipe, withNumbering } from './recipe.js'
import type { Macro, Recipe } from './recipe.js'
import { authorizePath } from './trust.js'
import type { Trust } from './trust.js'

const DOCUMENTS = new Set(['.yaml', '.yml', '.json'])

export type LibraryKind = 'macros' | 'data' | 'recipes'

export interface Library {
  recipes: Map<string, Recipe>
  macros: Map<string, Macro>
  data: Record<string, unknown>
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
): Library {
  const macros = new Map<string, Macro>()
  for (const { name, file, raw } of documents.macros) {
    const macro = parseMacro(raw, { finders, file })
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
    const recipe = withNumbering(parseRecipe(raw, { finders, file, name }))
    recipes.set(recipe.name!, recipe)
  }

  return { recipes, macros, data }
}

/** A discovered document whose authorized target stays inside its read operation. */
export interface ReadableLibraryDocument {
  readonly name: string
  readonly file: string
  read(): unknown
}

/** A discovered document that policy refused before it could be read. */
export interface RefusedLibraryDocument {
  readonly name: string
  readonly file: string
  readonly error: unknown
}

export type DiscoveredLibraryDocument = ReadableLibraryDocument | RefusedLibraryDocument

/** One authorized Library directory and the entries discovered inside it. */
export interface DiscoveredLibraryGroup {
  readonly kind: LibraryKind
  readonly file: string
  readonly documents: readonly DiscoveredLibraryDocument[]
}

/** One configured Library directory that policy or the filesystem refused. */
export interface RefusedLibraryGroup {
  readonly kind: LibraryKind
  readonly file: string
  readonly documents: readonly []
  readonly stage: 'authorization' | 'enumeration'
  readonly error: unknown
}

export type LibraryGroup = DiscoveredLibraryGroup | RefusedLibraryGroup

/** The complete policy-aware view of configured Library directories and entries. */
export interface LibraryDiscovery {
  readonly groups: readonly LibraryGroup[]
}

type PreparedGroup =
  | { kind: LibraryKind; file: string; target: string }
  | { kind: LibraryKind; file: string; stage: 'authorization'; error: unknown }

/** List supported document filenames in stable order. */
function documentFiles(dir: string): Array<{ name: string; file: string }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => DOCUMENTS.has(extname(entry)) && !entry.startsWith('.'))
    .sort()
    .map((entry) => ({ name: basename(entry, extname(entry)), file: join(dir, entry) }))
}

/** Discover every configured Library directory and entry through one Trust policy. */
export function discoverLibrary(loaded: LoadedConfig, trust: Trust): LibraryDiscovery {
  const kinds: readonly LibraryKind[] = ['macros', 'data', 'recipes']
  // Authorize every directory before enumerating one, so Run opening never observes a
  // malformed document before a later configured directory is refused.
  const prepared: PreparedGroup[] = kinds.map((kind) => {
    const file = fromRoot(loaded, loaded.config.paths[kind])
    try {
      return { kind, file, target: authorizePath(trust, file, `paths.${kind}`) }
    } catch (error) {
      return { kind, file, stage: 'authorization', error }
    }
  })

  const groups = Object.freeze(
    prepared.map((group): LibraryGroup => {
      if ('error' in group) return Object.freeze({ ...group, documents: [] })
      try {
        const documents = Object.freeze(
          documentFiles(group.target).map(({ name, file: target }): DiscoveredLibraryDocument => {
            const file = join(group.file, basename(target))
            try {
              const authorized = authorizePath(trust, target, `paths.${group.kind}`)
              return Object.freeze({ name, file, read: () => readDocumentAt(authorized, file) })
            } catch (error) {
              return Object.freeze({ name, file, error })
            }
          }),
        )
        return Object.freeze({ kind: group.kind, file: group.file, documents })
      } catch (error) {
        return Object.freeze({
          kind: group.kind,
          file: group.file,
          documents: [],
          stage: 'enumeration',
          error,
        })
      }
    }),
  )

  return Object.freeze({ groups })
}
