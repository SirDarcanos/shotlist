import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import * as shotlist from '../src/index.js'
import {
  baselineFile,
  countDocuments,
  lint,
  openRun,
  parseConfig,
  parseLibrary,
  parseMacro,
  parseQuery,
  parseRecipe,
  readBaseline,
  readSession,
  ShotlistError,
  signIn,
  startServer,
  withServer,
  writeBaseline,
} from '../src/index.js'
import type {
  CaptureReport,
  CaptureRequest,
  CheckReport,
  CheckRequest,
  Run,
  RunProgress,
  RunProgressObserver,
} from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

if (false) {
  const run = {} as Run
  const captureRequest: CaptureRequest = { recipes: ['home'] }
  const checkRequest: CheckRequest = { all: true }
  const observer: RunProgressObserver = (progress: RunProgress) => progress.type
  void run
    .capture({ ...captureRequest, onProgress: observer })
    .then((report: CaptureReport) => report.warnings?.join('\n'))
  void run.check(checkRequest).then((report: CheckReport) => report.warnings?.join('\n'))
  void new ShotlistError('invalid usage')

  // @ts-expect-error Low-level Step execution is not a package-root interface.
  shotlist.runSteps
  // @ts-expect-error Low-level browser context details are not a package-root type.
  void ({} as shotlist.RunContext)
  // @ts-expect-error Direct one-Recipe Capture is not a package-root interface.
  shotlist.shoot
  // @ts-expect-error Direct one-Recipe Checking is not a package-root interface.
  shotlist.check
  // @ts-expect-error Direct Capture options are not a package-root type.
  void ({} as shotlist.ShootOptions)
  // @ts-expect-error Direct Checking options are not a package-root type.
  void ({} as shotlist.CheckOptions)
  // @ts-expect-error Direct Capture results are not a package-root type.
  void ({} as shotlist.ShotResult)
  // @ts-expect-error Direct Checking results are not a package-root type.
  void ({} as shotlist.CheckResult)
  // @ts-expect-error Direct retry callbacks are replaced by Run progress.
  void ({} as shotlist.Retry)
  // @ts-expect-error Run requests do not accept caller-owned browsers.
  void run.capture({ recipes: ['home'], browser: {} })
  // @ts-expect-error Run requests select Recipe names rather than copied Recipe records.
  void run.check({ recipes: [{}] })
  // @ts-expect-error Session access requires a Run.
  readSession({}, 'admin')
  // @ts-expect-error Session access takes a configured name rather than Session details.
  readSession(run, { name: 'admin', file: 'elsewhere', keep: [] })
  // @ts-expect-error Login no longer accepts loaded config, Library, and Session arguments.
  void signIn({}, {}, {}, {})
  // @ts-expect-error Serving requires a Run.
  void startServer({})
  // @ts-expect-error Baseline access requires a Run.
  readBaseline({ root: '/tmp' })
  // @ts-expect-error Lint requires explicit Operator authority.
  lint()
  // @ts-expect-error Document counting requires explicit Operator authority.
  countDocuments()
  // @ts-expect-error Filesystem-backed config loading is not public.
  shotlist.loadConfig
  // @ts-expect-error Unrestricted Library loading is not public.
  shotlist.loadLibrary
  // @ts-expect-error Raw trust construction is not public.
  shotlist.trustFrom
  // @ts-expect-error Session paths are not a package-root type.
  void ({} as shotlist.Session)
  // @ts-expect-error Session narrowing details are not a package-root type.
  void ({} as shotlist.Dropped)
  // @ts-expect-error Session storage internals are not a package-root type.
  void ({} as shotlist.StorageState)
  // @ts-expect-error The CLI runner is not a package-root interface.
  shotlist.run

  void run
}

afterAll(removeProjects)

describe('the contracted public interface', () => {
  it('does not expose unrestricted loaders, raw trust controls, Session internals, or the CLI runner', () => {
    expect('loadConfig' in shotlist).toBe(false)
    expect('loadLibrary' in shotlist).toBe(false)
    expect('trustFrom' in shotlist).toBe(false)
    expect('checkPath' in shotlist).toBe(false)
    expect('sessionFor' in shotlist).toBe(false)
    expect('sessionHosts' in shotlist).toBe(false)
    expect('narrowSession' in shotlist).toBe(false)
    expect('run' in shotlist).toBe(false)
    expect('runSteps' in shotlist).toBe(false)
    expect('shoot' in shotlist).toBe(false)
    expect('check' in shotlist).toBe(false)
  })

  it('parses supplied values without opening a Run', () => {
    expect(parseConfig({ site: { url: 'https://example.test' } }).site.url).toBe(
      'https://example.test',
    )
    expect(parseRecipe({ clip: 'viewport' }, { name: 'home' }).name).toBe('home')
    expect(parseMacro({ steps: [] }).steps).toEqual([])
    expect(parseQuery({ css: 'main' })).toEqual({ css: 'main' })
    expect(
      parseLibrary({
        macros: [],
        data: [],
        recipes: [{ name: 'home', file: 'home.yaml', raw: { clip: 'viewport' } }],
      }).recipes.has('home'),
    ).toBe(true)
  })

  it('rejects a forged Run before any effect or callback', async () => {
    const root = tempProject()
    const authentic = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const forged = { ...authentic } as Run
    let touched = false
    const body = async () => {
      touched = true
      return 1
    }

    expect(() => baselineFile(forged)).toThrow(/A Run opened by shotlist is required/)
    expect(() => readBaseline(forged)).toThrow(/A Run opened by shotlist is required/)
    expect(() => writeBaseline(forged, {})).toThrow(/A Run opened by shotlist is required/)
    expect(() => readSession(forged, 'admin')).toThrow(/A Run opened by shotlist is required/)
    await expect(startServer(forged)).rejects.toThrow(/A Run opened by shotlist is required/)
    await expect(withServer(forged, body)).rejects.toThrow(/A Run opened by shotlist is required/)
    await expect(signIn(forged, 'admin', { say: () => (touched = true) })).rejects.toThrow(
      /A Run opened by shotlist is required/,
    )
    expect(touched).toBe(false)
  })

  it('rejects invalid Run requests as usage errors', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))

    await expect(run.capture({ recipes: [] })).rejects.toBeInstanceOf(ShotlistError)
    await expect(run.check({ all: true, recipes: ['order-row'] } as never)).rejects.toThrow(
      /either.*recipes.*all/i,
    )
  })
})
