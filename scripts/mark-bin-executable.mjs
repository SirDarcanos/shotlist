// `tsc` writes 0644 and npm publishes the mode the file has, so a bin left as the compiler
// wrote it installs as something the shell refuses to run. The names come from `bin` in
// package.json, so a second binary cannot be added and forgotten.
import { chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { bin } = createRequire(import.meta.url)('../package.json')

for (const [name, file] of Object.entries(bin)) {
  chmodSync(join(root, file), 0o755)
  console.log(`  ✓ ${file} is executable, for \`${name}\``)
}
