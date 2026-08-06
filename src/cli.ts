#!/usr/bin/env node
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ShotlistError, fromRoot, loadConfig } from './config.js'
import { loadLibrary, withNumbering } from './recipe.js'
import type { Library, Recipe } from './recipe.js'
import { shoot } from './capture.js'
import { check } from './check.js'
import { loadPlaywright } from './playwright.js'

const USAGE = `shotlist — annotated UI screenshots from YAML recipes

  shotlist                       list every recipe
  shotlist <name>...             shoot these recipes into the out directory
  shotlist <name>... --install   …and copy each to its install destination
  shotlist --all --install       shoot everything
  shotlist --check [<name>...]   re-shoot and compare against the committed images

  --config <file>   use this config instead of the nearest one
  --help            this
  --version         print the version`

/** Where output goes, so tests can read it instead of the terminal. */
export interface Io {
  out(line: string): void
  err(line: string): void
}

const CONSOLE: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

/** Load the project's config and its recipes, macros and data. */
function open(configFile?: string): { loaded: ReturnType<typeof loadConfig>; library: Library } {
  const loaded = loadConfig(configFile)
  const { paths, finders } = loaded.config
  const library = loadLibrary({
    recipes: fromRoot(loaded, paths.recipes),
    macros: fromRoot(loaded, paths.macros),
    data: fromRoot(loaded, paths.data),
    finders,
  })
  return { loaded, library }
}

/** The recipes named on the command line, or all of them, refusing an unknown name. */
function pick(library: Library, names: readonly string[], all: boolean): Recipe[] {
  const chosen = all || names.length === 0 ? [...library.recipes.keys()] : names
  return chosen.map((name) => {
    const recipe = library.recipes.get(name)
    if (!recipe) {
      const known = [...library.recipes.keys()].sort()
      throw new ShotlistError(
        `unknown recipe "${name}"` +
          (known.length ? ` — this project has ${known.join(', ')}` : ''),
      )
    }
    return withNumbering(recipe)
  })
}

/** Run the command line, returning the exit code rather than exiting. */
export async function run(argv: readonly string[], io: Io = CONSOLE): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        install: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        config: { type: 'string' },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    io.err((error as Error).message)
    io.err(USAGE)
    return 1
  }
  const { values, positionals } = parsed

  if (values.help) {
    io.out(USAGE)
    return 0
  }
  if (values.version) {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
    io.out(pkg.version)
    return 0
  }

  try {
    const { loaded, library } = open(values.config)

    // No recipe named and nothing to do with them: list what there is.
    if (!values.all && !values.check && positionals.length === 0) {
      if (library.recipes.size === 0) {
        io.out(`no recipes in ${fromRoot(loaded, loaded.config.paths.recipes)}`)
        return 0
      }
      for (const name of [...library.recipes.keys()].sort()) io.out(name)
      return 0
    }

    const recipes = pick(library, positionals, values.all)

    if (values.check) {
      const results = await check(recipes, library, loaded)
      let changed = 0
      for (const result of results) {
        if (result.status === 'same') {
          io.out(`  same     ${result.name}`)
        } else if (result.status === 'changed') {
          changed++
          const why = result.reason ?? `${(100 * (result.ratio ?? 0)).toFixed(2)}% of pixels differ`
          io.out(`  CHANGED  ${result.name} — ${why}`)
          io.out(`           committed: ${result.against}`)
          io.out(`           re-shot:   ${result.shot}`)
        } else if (result.status === 'new') {
          changed++
          io.out(`  NEW      ${result.name} — nothing committed at ${result.against}`)
        } else {
          io.out(`  skipped  ${result.name} — ${result.reason}`)
        }
      }
      io.out(
        changed ? `${changed} of ${results.length} need attention` : 'every screenshot is current',
      )
      return changed ? 1 : 0
    }

    const browser = await loadPlaywright().chromium.launch()
    try {
      for (const recipe of recipes) {
        const result = await shoot(recipe, library, loaded, {
          install: values.install,
          browser,
        })
        io.out(`  ✓ ${result.name} → ${result.file}`)
        if (result.installed) io.out(`    installed ${result.installed}`)
        for (const warning of result.warnings ?? []) io.out(`    ! ${warning}`)
      }
    } finally {
      await browser.close()
    }
    return 0
  } catch (error) {
    io.err(error instanceof ShotlistError ? error.message : String(error))
    return 1
  }
}

// Only when this file is what was executed, so importing it in a test runs nothing.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2))
}
