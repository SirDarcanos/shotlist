// Generate the JSON Schemas an editor reads, from the zod schemas that already
// validate at run time. Two definitions of a recipe's shape would drift; this is why
// there is only one.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Config, Recipe, Macro } from '../dist/index.js'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

// `io: 'input'` describes what an author writes, not what the parser hands back —
// every field with a default is optional in a document and required after parsing.
const options = { io: 'input', target: 'draft-7' }

// `schema.json` is what the config's schema was called before it said so. An editor is
// pointed at these by path — `$schema=…/dist/schema.json` in a YAML header, or a glob in
// a workspace setting — so dropping the old name would stop autocomplete with no error to
// read. Both are written; the old one goes at 1.0.
for (const [file, schema, title] of [
  ['config.schema.json', Config, 'shotlist config'],
  ['schema.json', Config, 'shotlist config'],
  ['recipe.schema.json', Recipe, 'shotlist recipe'],
  ['macro.schema.json', Macro, 'shotlist macro'],
]) {
  const json = { title, ...z.toJSONSchema(schema, options) }
  writeFileSync(join(dist, file), `${JSON.stringify(json, null, 2)}\n`)
  console.log(`  ✓ dist/${file}`)
}
