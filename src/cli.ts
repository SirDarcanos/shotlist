#!/usr/bin/env node
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { ShotlistError, fromRoot } from './config.js'
import type {
  CaptureReport,
  CaptureRequest,
  CheckReport,
  CheckRequest,
  RunProgress,
} from './execute.js'
import { scaffold } from './init.js'
import { formatProblems, reviewProject } from './lint.js'
import { signIn } from './session.js'
import { openRun } from './run.js'
import type { OperatorAuthority } from './run.js'
import type { NetworkDestination } from './network-policy.js'
import { BASELINE_FILE } from './baseline.js'
import { parseWorkLimitChanges } from './work-limit.js'

const USAGE = `shotlist — annotated UI screenshots from YAML recipes

  shotlist --init                write a starter config and recipe
  shotlist                       list every recipe
  shotlist <name>...             shoot these recipes into the out directory
  shotlist <name>... --install   …and copy each to its install destination
  shotlist --all --install       shoot everything
  shotlist --check [<name>...]   re-shoot and compare against the committed images
  shotlist --check --diff        …and write a before/after/changed image for each
  shotlist --check --json        …and report it as JSON on stdout
  shotlist --lint                check every recipe, macro and data file, and stop
  shotlist --login <name>        sign in by hand, and save the session under this name
  shotlist --login <name> --using <macro>
                                 …signing in with a macro instead of by hand

  --config <file>   use this config instead of the nearest one
  --using <macro>   with --login, the macro that signs in, for a run with nobody at it
  --warnings        with --lint, also report what is legal but probably not meant
  --allow-env <n>   let a recipe read this variable as \${env.<n>}; repeatable.
                    allowEnv in the config does the same for every run
  --keep-going      carry on past a recipe that fails, and report them at the end
  --untrusted       the config is not yours: no processes, no leaving the project,
                    and nothing opened on the network this machine sits in
  --allow <dest>    approve one Network destination; repeatable
  --allow-path <p>  also read and write under this directory; repeatable
  --deny <name>     never read or write this file or folder name; repeatable
  --work-limit <n=v>
                    change one numerical Work limit for this Run; repeatable
                    SHOTLIST_WORK_LIMITS accepts comma-separated name=value settings
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

/** Render canonical Operator approvals without URL paths or other request data. */
function destinationList(destinations: readonly NetworkDestination[]): string {
  if (!destinations.length) return 'none'
  return destinations
    .map((destination) => {
      const standard =
        (destination.protocol === 'https:' && destination.port === 443) ||
        (destination.protocol === 'http:' && destination.port === 80)
      const host = `${destination.subdomains ? '*.' : ''}${destination.host}`
      return `${destination.protocol}//${host}${standard ? '' : `:${destination.port}`}`
    })
    .join(', ')
}

/** Turn an unknown report failure into one line for a terminal. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render retry progress while the Run remains active. */
function renderProgress(progress: RunProgress, say: (line: string) => void): void {
  if (progress.type === 'recipe-start') {
    say(`  … ${progress.name}`)
  } else if (progress.type === 'retry') {
    say(
      `  ↻ ${progress.name} — attempt ${progress.attempt} of ${progress.of} failed: ` +
        progress.why.replace(`recipe "${progress.name}": `, ''),
    )
  } else if (progress.type === 'installation-start') {
    say(`  … installing ${progress.name}`)
  }
}

/** Render one complete Capture report and return whether execution failed. */
function renderCaptureReport(
  report: CaptureReport,
  say: (line: string) => void,
  complain: (line: string) => void,
): boolean {
  for (const result of report.results) {
    if (result.status === 'captured') {
      say(`  ✓ ${result.name} → ${result.shot.file}`)
      for (const warning of result.shot.warnings ?? []) say(`    ! ${warning}`)
    } else if (result.status === 'failed') {
      complain(`  ✗ ${result.name} — ${failureMessage(result.error)}`)
      for (const failure of result.cleanupFailures ?? []) {
        complain(`    cleanup also failed: ${failureMessage(failure)}`)
      }
    } else if (result.status === 'cancelled') {
      complain(`  ✗ ${result.name} — cancelled: ${failureMessage(result.reason)}`)
      for (const failure of result.cleanupFailures ?? []) {
        complain(`    cleanup also failed: ${failureMessage(failure)}`)
      }
    } else {
      complain(`  - ${result.name} — not attempted: ${result.reason}`)
    }
  }

  for (const failure of report.failures) {
    complain(`  ✗ ${failure.resource} ${failure.stage} failed: ${failureMessage(failure.error)}`)
  }

  for (const result of report.installation.results) {
    if (result.status === 'installed') {
      say(`    installed ${result.file}`)
    } else if (result.status === 'withheld') {
      complain(`    ! installation withheld for ${result.name} — ${result.reason}`)
    } else if (result.status === 'failed') {
      complain(`    ✗ installation failed for ${result.name}: ${failureMessage(result.error)}`)
    } else if (result.status === 'not-attempted') {
      complain(`    - installation not attempted for ${result.name} — ${result.reason}`)
    }
  }

  if (report.installation.baseline.status === 'recorded') {
    say(`  recorded this machine in ${BASELINE_FILE}`)
  } else if (report.installation.baseline.status === 'failed') {
    complain(
      `  ✗ Baseline could not be recorded: ${failureMessage(report.installation.baseline.error)}`,
    )
  }
  for (const warning of report.warnings ?? []) complain(`  ! ${warning}`)

  return (
    report.results.some((result) => result.status !== 'captured') ||
    report.failures.length > 0 ||
    report.installation.results.some(
      (result) =>
        result.status === 'withheld' ||
        result.status === 'failed' ||
        result.status === 'not-attempted',
    ) ||
    report.installation.baseline.status === 'failed'
  )
}

/** Note the regions a result did not cover, so a pass is not read as covering them. */
function notCompared(result: { ignored?: number }): string {
  return result.ignored
    ? `  (${result.ignored} region${result.ignored === 1 ? '' : 's'} not compared)`
    : ''
}

/** Render one complete Checking report and return its attention count. */
function renderCheckReport(report: CheckReport, say: (line: string) => void): number {
  if (report.drift.length) {
    say('! this is not the machine the committed images were taken on:')
    for (const { field, was, now } of report.drift) say(`    ${field}: ${was} → ${now}`)
    say('  Differences below may be that, rather than the site.')
  }

  let attention = 0
  for (const result of report.results) {
    if (result.status === 'same') {
      say(`  same     ${result.name}${notCompared(result)}`)
    } else if (result.status === 'changed') {
      attention++
      const why = result.reason ?? `${(100 * (result.ratio ?? 0)).toFixed(2)}% of pixels differ`
      say(`  CHANGED  ${result.name} — ${why}${notCompared(result)}`)
      say(`           committed: ${result.against}`)
      say(`           re-shot:   ${result.shot}`)
      if (result.diff) say(`           diff:      ${result.diff}`)
    } else if (result.status === 'new') {
      attention++
      say(`  NEW      ${result.name} — nothing committed at ${result.against}`)
    } else if (result.status === 'skipped') {
      say(`  skipped  ${result.name} — ${result.reason}`)
    } else if (result.status === 'failed') {
      attention++
      say(`  FAILED   ${result.name} — ${failureMessage(result.error)}`)
      for (const failure of result.cleanupFailures ?? []) {
        say(`           cleanup also failed: ${failureMessage(failure)}`)
      }
    } else if (result.status === 'cancelled') {
      attention++
      say(`  FAILED   ${result.name} — cancelled: ${failureMessage(result.reason)}`)
      for (const failure of result.cleanupFailures ?? []) {
        say(`           cleanup also failed: ${failureMessage(failure)}`)
      }
    } else {
      attention++
      say(`  FAILED   ${result.name} — not attempted: ${result.reason}`)
    }
  }
  for (const failure of report.failures) {
    say(`  FAILED   ${failure.resource} ${failure.stage} — ${failureMessage(failure.error)}`)
  }
  for (const warning of report.warnings ?? []) say(`  ! ${warning}`)
  say(
    attention
      ? `${attention} of ${report.results.length} need attention`
      : report.failures.length
        ? `checking failed with ${report.failures.length} Run-level failure${report.failures.length === 1 ? '' : 's'}`
        : 'every screenshot is current',
  )
  return attention
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
        lint: { type: 'boolean', default: false },
        warnings: { type: 'boolean', default: false },
        untrusted: { type: 'boolean', default: false },
        allow: { type: 'string', multiple: true },
        'allow-path': { type: 'string', multiple: true },
        deny: { type: 'string', multiple: true },
        'work-limit': { type: 'string', multiple: true },
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
  if (values.json && (values.init || values.lint || values.login !== undefined)) {
    io.err('--json cannot report --init, --lint, or --login')
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

  let authority: OperatorAuthority
  try {
    authority = {
      untrusted: values.untrusted,
      destinations: values.allow ?? [],
      paths: values['allow-path'] ?? [],
      deny: values.deny ?? [],
      env: values['allow-env'] ?? [],
      workLimits: parseWorkLimitChanges(values['work-limit'] ?? []),
    }
  } catch (error) {
    io.err((error as Error).message)
    return 1
  }

  // Before a complete Run is opened, because malformed Library documents are what this
  // command has to accumulate rather than stop at.
  if (values.lint) {
    const report = reviewProject(authority, values.config, { warnings: values.warnings })
    for (const line of formatProblems(report.problems, report.checked)) io.out(line)
    return report.problems.some((one) => one.level === 'error') ? 1 : 0
  }

  try {
    const shotRun = openRun(authority, values.config)
    const { project } = shotRun
    const { library } = project

    if (values.login !== undefined) {
      io.out(`Operator Network destinations: ${destinationList(shotRun.operatorDestinations)}`)
      await signIn(shotRun, values.login, {
        ...(values.using !== undefined ? { using: values.using } : {}),
        ...(io.pause ? { pause: io.pause.bind(io) } : {}),
        say: io.out,
      })
      return 0
    }

    // No recipe named and nothing to do with them: list what there is.
    if (!values.all && !values.check && positionals.length === 0) {
      if (library.recipes.size === 0) {
        io.out(`no recipes in ${fromRoot(project, project.config.paths.recipes)}`)
        return 0
      }
      for (const name of [...library.recipes.keys()].sort()) io.out(name)
      return 0
    }

    const selection =
      values.all || (values.check && positionals.length === 0)
        ? ({ all: true } as const)
        : ({ recipes: positionals } as const)
    const keepGoing = values['keep-going']

    if (values.check) {
      // With `--json` the report is stdout, so everything written for a person moves
      // aside — `shotlist --check --json > report.json` has to leave a usable file.
      const say = values.json ? io.err : io.out
      say(`Operator Network destinations: ${destinationList(shotRun.operatorDestinations)}`)
      const request: CheckRequest = {
        ...selection,
        keepGoing,
        diff: values.diff,
        onProgress: (progress) => renderProgress(progress, say),
      }
      const report = await shotRun.check(request)
      const changed = renderCheckReport(report, say)
      if (values.json) {
        io.out(
          JSON.stringify(
            { changed, total: report.results.length, ...report },
            (_key, value) => (value instanceof Error ? value.message : value),
            2,
          ),
        )
      }
      return changed || report.failures.length || report.cancellation ? 1 : 0
    }

    io.out(`Operator Network destinations: ${destinationList(shotRun.operatorDestinations)}`)
    const request: CaptureRequest = {
      ...selection,
      install: values.install,
      keepGoing,
      onProgress: (progress) => renderProgress(progress, io.out),
    }
    const report = await shotRun.capture(request)
    const failed = renderCaptureReport(report, io.out, io.err)
    const failedNames = report.results
      .filter((result) => result.status === 'failed')
      .map((result) => result.name)
    if (failedNames.length) {
      io.err(`${failedNames.length} of ${report.results.length} failed: ${failedNames.join(', ')}`)
    }
    return failed ? 1 : 0
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
