import { Config } from './config.js'
import { Macro, Recipe } from './recipe.js'
import type { z } from 'zod'

/**
 * Which JSON Schema is written under which name.
 *
 * `schema.json` is what the config's schema was called before it said so. An editor is
 * pointed at these by path — `$schema=…/dist/schema.json` in a YAML header, or a glob in a
 * workspace setting — so dropping the old name would stop autocomplete with no error to
 * read. Both are written; the old one goes at 1.0.
 */
export const SCHEMA_FILES: ReadonlyArray<{ file: string; schema: z.ZodType; title: string }> = [
  { file: 'config.schema.json', schema: Config, title: 'shotlist config' },
  { file: 'schema.json', schema: Config, title: 'shotlist config' },
  { file: 'recipe.schema.json', schema: Recipe, title: 'shotlist recipe' },
  { file: 'macro.schema.json', schema: Macro, title: 'shotlist macro' },
]
