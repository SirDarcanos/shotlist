// Generate the JSON Schemas an editor reads, from the zod schemas that already
// validate at run time. Two definitions of a recipe's shape would drift; this is why
// there is only one.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { SCHEMA_FILES } from '../dist/index.js'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

// `io: 'input'` describes what an author writes, not what the parser hands back —
// every field with a default is optional in a document and required after parsing.
const options = { io: 'input', target: 'draft-7' }

for (const { file, schema, title } of SCHEMA_FILES) {
  const json = { title, ...z.toJSONSchema(schema, options) }
  writeFileSync(join(dist, file), `${JSON.stringify(json, null, 2)}\n`)
  console.log(`  ✓ dist/${file}`)
}
