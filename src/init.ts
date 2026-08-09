import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A starter config.
 *
 * Commented rather than minimal: the keys someone reaches for first are the ones worth
 * having in front of them, and a line to uncomment beats a line to look up.
 */
const CONFIG = `# Where the site is, and how it is captured. Every recipe inherits this.
site:
  url: http://localhost:3000

  # Started when nothing answers at \`url\`, and stopped after the last shot. Without it
  # the site has to be running already.
  # serve: npm run dev

  viewport: { width: 1440, height: 900 }
  scale: 2 # device pixel ratio; 2 gives Retina images
  theme: light # light | dark | no-preference

  # A selector proving the page is up, waited for after every navigation.
  # ready: '[data-app-ready]'

  # Signed-in states for pages needing an account: \`shotlist --login admin\`, then
  # \`session: admin\` in a recipe. Holds live cookies — gitignore it, never commit it.
  # \`verify\` catches a session that expired, which redirects rather than failing.
  # sessions:
  #   admin: { path: .shotlist/admin.json, verify: '[data-signed-in]' }

# Named destinations a recipe copies to with \`install: <name>\`, given --install.
install:
  docs: docs/images

# Query aliases a recipe calls by name, with \$1 as the first argument.
# finders:
#   listRow:
#     css: 'li, div'
#     contains: \$1
#     pick: smallest
`

/** A starter recipe, pointing at the schema so an editor completes the keys. */
const RECIPE = `# yaml-language-server: \$schema=../../node_modules/shotlist/dist/recipe.schema.json

# One screenshot. The filename is its name unless \`name:\` says otherwise.
name: example
install: docs

# Drive the page into the state worth capturing. Every verb is in the README.
# setup:
#   - click: { role: button, name: Orders }

# What to capture: \`viewport\`, \`full\`, or a query for one region.
clip: viewport

# Named regions, resolved after \`setup\` runs, for callouts to point at.
# marks:
#   total: { within: clip, text: \$42.00 }

# What to draw. \`place\` is the side the label sits on: choose the one with clear
# space, because the arrow crosses whatever lies between.
# callouts:
#   - { mark: total, text: What they owe, place: left }
`

/** A file the scaffold was asked to create, and whether it had to. */
export interface Scaffolded {
  file: string
  written: boolean
}

/**
 * Write a starter config and recipe, leaving anything already there alone.
 *
 * Never overwrites: someone running this in a project that already has recipes meant to
 * add the missing half, not to lose the written one.
 */
export function scaffold(configFile: string): Scaffolded[] {
  const root = dirname(configFile)
  return [
    { file: configFile, contents: CONFIG },
    { file: join(root, 'screenshots', 'recipes', 'example.yaml'), contents: RECIPE },
  ].map(({ file, contents }) => {
    if (existsSync(file)) return { file, written: false }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
    return { file, written: true }
  })
}
