#!/usr/bin/env node
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { ShotlistError, fromRoot, loadConfig } from './config.js'
import { loadLibrary, withNumbering } from './recipe.js'
import type { Library, Recipe } from './recipe.js'
import { shoot } from './capture.js'
import type { Retry } from './capture.js'
import { check } from './check.js'
import { loadPlaywright } from './playwright.js'
import { withServer } from './serve.js'
import { scaffold } from './init.js'
import { trustFrom } from './trust.js'
import { sessionFor, signIn } from './session.js'
import {
  BASELINE_FILE,
  describeEnvironment,
  environmentDrift,
  readBaseline,
  writeBaseline,
} from './baseline.js'

const USAGE = `shotlist — annotated UI screenshots from YAML recipes

  shotlist --init                write a starter config and recipe
  shotlist                       list every recipe
  shotlist <name>...             shoot these recipes into the out directory
  shotlist <name>... --install   …and copy each to its install destination
  shotlist --all --install       shoot everything
  shotlist --check [<name>...]   re-shoot and compare against the committed images
  shotlist --check --diff        …and write a before/after/changed image for each
  shotlist --check --json        …and report it as JSON on stdout
  shotlist --login <name>        sign in by hand, and save the session under this name
  shotlist --login <name> --using <macro>
                                 …signing in with a macro instead of by hand

  --config <file>   use this config instead of the nearest one
  --using <macro>   with --login, the macro that signs in, for a run with nobody at it
  --allow-env <n>   let a recipe read this variable as \${env.<n>}; repeatable
  --keep-going      carry on past a recipe that fails, and report them at the end
  --untrusted       the config is not yours: no processes, no leaving the project,
                    and nothing opened on the network this machine sits in
  --allow <host>    also open this host and anything under it; repeatable
  --allow-path <p>  also read and write under this directory; repeatable
  --deny <name>     never read or write this file or folder name; repeatable
  --help            this
  --version         print the version`

/** Where output goes, so tests can read it instead of the terminal. */
export interface Io {
  out(line: string): void
  err(line: string): void
  /** Wait for the person to say they are done, which only `--login` by hand needs. */
  pause?(): Promise<void>
}

const CONSOLE: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  pause: () =>
    new Promise((done) => {
      process.stdin.resume()
      process.stdin.once('data', () => {
        process.stdin.pause()
        done()
      })
    }),
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
        init: { type: 'boolean', default: false },
        install: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        config: { type: 'string' },
        login: { type: 'string' },
        using: { type: 'string' },
        'allow-env': { type: 'string', multiple: true },
        'keep-going': { type: 'boolean', default: false },
        diff: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        untrusted: { type: 'boolean', default: false },
        allow: { type: 'string', multiple: true },
        'allow-path': { type: 'string', multiple: true },
        deny: { type: 'string', multiple: true },
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

  if (values.json && !values.check) {
    io.err('--json reports a --check run, and there is nothing else for it to report')
    return 1
  }
  if (values.using !== undefined && values.login === undefined) {
    io.err('--using names the macro that signs in, which only a --login run does')
    return 1
  }

  // Before anything is loaded: this is the command for a project that has no config.
  if (values.init) {
    const target = resolve(values.config ?? 'shotlist.config.yaml')
    const made = scaffold(target)
    for (const { file, written } of made) {
      io.out(written ? `  wrote ${file}` : `  left ${file} alone, it is already there`)
    }
    if (made.some((one) => one.written)) {
      io.out('\nStart the site, then shoot it:\n  npx shotlist example')
    }
    return 0
  }

  try {
    const { loaded, library } = open(values.config)
    // Set here and nowhere else: a control the config could switch off is not one.
    // `--allow` comes from whoever typed the command, so unlike `site.allow` it is still
    // worth something when the config is not theirs.
    loaded.trust = trustFrom(
      {
        root: loaded.root,
        siteUrl: loaded.config.site.url,
        allow: loaded.config.site.allow,
        deny: loaded.config.deny,
        granted: {
          hosts: values.allow ?? [],
          paths: values['allow-path'] ?? [],
          deny: values.deny ?? [],
          env: values['allow-env'] ?? [],
        },
      },
      values.untrusted,
    )

    if (values.login !== undefined) {
      const session = sessionFor(loaded, values.login, '--login')
      await signIn(loaded, library, session, {
        ...(values.using !== undefined ? { using: values.using } : {}),
        ...(io.pause ? { pause: io.pause.bind(io) } : {}),
        say: io.out,
      })
      return 0
    }

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
    const keepGoing = values['keep-going']

    /** Note the regions a result did not cover, so a pass is not read as covering them. */
    const notCompared = (result: { ignored?: number }) =>
      result.ignored
        ? `  (${result.ignored} region${result.ignored === 1 ? '' : 's'} not compared)`
        : ''

    /** Say an attempt failed while it is happening, so a retrying run is not silent. */
    const onRetry = (retry: Retry) =>
      io.out(
        `  ↻ ${retry.name} — attempt ${retry.attempt} of ${retry.of} failed: ` +
          // The line already names the recipe, so the message repeating it says nothing.
          retry.why.replace(`recipe "${retry.name}": `, ''),
      )

    /** Everything that wants the site up, so the server's lifetime is exactly this. */
    const work = async (): Promise<number> => {
      if (values.check) {
        // With `--json` the report is stdout, so everything written for a person moves
        // aside — `shotlist --check --json > report.json` has to leave a usable file.
        const say = values.json ? io.err : io.out
        const browser = await loadPlaywright().chromium.launch()
        let results
        let drift
        try {
          // Said before the results, so they are read in the light of it: a different
          // Chromium rasterises text differently, and that is not the site changing.
          drift = environmentDrift(readBaseline(loaded), describeEnvironment(browser))
          if (drift.length) {
            say('! this is not the machine the committed images were taken on:')
            for (const { field, was, now } of drift) say(`    ${field}: ${was} → ${now}`)
            say('  Differences below may be that, rather than the site.')
          }
          results = await check(recipes, library, loaded, {
            browser,
            keepGoing,
            onRetry,
            ...(values.diff
              ? { diffDir: join(fromRoot(loaded, loaded.config.paths.out), 'diff') }
              : {}),
          })
        } finally {
          await browser.close()
        }
        let changed = 0
        for (const result of results) {
          if (result.status === 'same') {
            say(`  same     ${result.name}${notCompared(result)}`)
          } else if (result.status === 'changed') {
            changed++
            const why =
              result.reason ?? `${(100 * (result.ratio ?? 0)).toFixed(2)}% of pixels differ`
            say(`  CHANGED  ${result.name} — ${why}${notCompared(result)}`)
            say(`           committed: ${result.against}`)
            say(`           re-shot:   ${result.shot}`)
            if (result.diff) say(`           diff:      ${result.diff}`)
          } else if (result.status === 'new') {
            changed++
            say(`  NEW      ${result.name} — nothing committed at ${result.against}`)
          } else if (result.status === 'failed') {
            changed++
            say(`  FAILED   ${result.name} — ${result.reason}`)
          } else {
            say(`  skipped  ${result.name} — ${result.reason}`)
          }
        }
        say(
          changed
            ? `${changed} of ${results.length} need attention`
            : 'every screenshot is current',
        )
        if (values.json) {
          io.out(JSON.stringify({ changed, total: results.length, drift, results }, null, 2))
        }
        return changed ? 1 : 0
      }

      const browser = await loadPlaywright().chromium.launch()
      const failed: string[] = []
      try {
        for (const recipe of recipes) {
          try {
            const result = await shoot(recipe, library, loaded, {
              install: values.install,
              browser,
              onRetry,
            })
            io.out(`  ✓ ${result.name} → ${result.file}`)
            if (result.installed) io.out(`    installed ${result.installed}`)
            for (const warning of result.warnings ?? []) io.out(`    ! ${warning}`)
          } catch (error) {
            // Without `--keep-going` the first failure is the answer. With it, one broken
            // recipe must not hide what the other thirty-nine would have said.
            if (!keepGoing) throw error
            failed.push(recipe.name!)
            io.err(`  ✗ ${error instanceof ShotlistError ? error.message : String(error)}`)
          }
        }
      } finally {
        await browser.close()
      }
      if (failed.length) {
        io.err(`${failed.length} of ${recipes.length} failed: ${failed.join(', ')}`)
        return 1
      }
      // What was just installed is the baseline a later `--check` compares against, so
      // this is the moment the machine that took it is worth recording.
      if (values.install) {
        writeBaseline(loaded, describeEnvironment(browser))
        io.out(`  recorded this machine in ${BASELINE_FILE}`)
      }
      return 0
    }

    // A set of `source: file` recipes never opens the site, and should not wait on one.
    const needsSite = recipes.some((recipe) => recipe.source === 'app')
    return needsSite ? await withServer(loaded, work) : await work()
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
