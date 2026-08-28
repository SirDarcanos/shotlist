import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASELINE_FILE,
  describeEnvironment,
  environmentDrift,
  openRun,
  readBaseline,
  writeBaseline,
} from '../src/index.js'
import type { Environment } from '../src/index.js'

const made: string[] = []
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), 'shotlist-baseline-'))
  made.push(dir)
  return { root: dir }
}

/** Open a Run rooted beside its Baseline record. */
function baselineRun() {
  const loaded = root()
  const config = join(loaded.root, 'shotlist.config.json')
  writeFileSync(config, JSON.stringify({ site: { url: 'https://example.com' } }))
  return { loaded, run: openRun({ untrusted: false }, config) }
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('describeEnvironment', () => {
  it('records what the machine is, and its own version', () => {
    const environment = describeEnvironment()
    expect(environment.platform).toBe(process.platform)
    expect(environment.shotlist).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('takes the browser version from the browser, when there is one', () => {
    expect(describeEnvironment().chromium).toBeUndefined()
    const browser = { newContext: () => Promise.reject(), close: () => Promise.resolve() }
    expect(describeEnvironment({ ...browser, version: () => '141.0.0.0' }).chromium).toBe(
      '141.0.0.0',
    )
  })
})

describe('the recorded baseline', () => {
  it('round-trips beside the config through its Run', () => {
    const loaded = root()
    const config = join(loaded.root, 'shotlist.config.json')
    writeFileSync(config, JSON.stringify({ site: { url: 'https://example.com' } }))
    const run = openRun({ untrusted: true }, config)
    const environment: Environment = { chromium: '141.0.0.0', platform: 'darwin' }

    writeBaseline(run, { platform: 'linux' })
    writeBaseline(run, environment)

    expect(readBaseline(run)).toEqual(environment)
    expect(readFileSync(join(loaded.root, BASELINE_FILE), 'utf8')).toContain('141.0.0.0')
    expect(readdirSync(loaded.root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses to read a Baseline through a path outside an untrusted Run', () => {
    const loaded = root()
    const config = join(loaded.root, 'shotlist.config.json')
    writeFileSync(config, JSON.stringify({ site: { url: 'https://example.com' } }))
    const run = openRun({ untrusted: true }, config)
    const outside = root().root
    writeFileSync(join(outside, BASELINE_FILE), '{}')
    symlinkSync(join(outside, BASELINE_FILE), join(loaded.root, BASELINE_FILE))

    expect(() => readBaseline(run)).toThrow(/shotlist\.baseline\.json: .*outside the project/)
  })

  it('refuses to write a Baseline through a path outside an untrusted Run', () => {
    const loaded = root()
    const config = join(loaded.root, 'shotlist.config.json')
    writeFileSync(config, JSON.stringify({ site: { url: 'https://example.com' } }))
    const run = openRun({ untrusted: true }, config)
    const outside = root().root
    const target = join(outside, BASELINE_FILE)
    writeFileSync(target, 'unchanged')
    symlinkSync(target, join(loaded.root, BASELINE_FILE))

    expect(() => writeBaseline(run, { platform: 'darwin' })).toThrow(
      /shotlist\.baseline\.json: .*outside the project/,
    )
    expect(readFileSync(target, 'utf8')).toBe('unchanged')
  })

  it('is absent for a Project that has never installed anything', () => {
    expect(readBaseline(baselineRun().run)).toBeNull()
  })

  it('names the file when it cannot be read', () => {
    const { loaded, run } = baselineRun()
    writeFileSync(join(loaded.root, BASELINE_FILE), '{ not json')
    expect(() => readBaseline(run)).toThrow(new RegExp(BASELINE_FILE))
  })
})

// A different Chromium rasterises text differently and a different platform has
// different faces to rasterise, so either moves pixels without the site moving at all.
describe('environmentDrift', () => {
  const was: Environment = {
    shotlist: '0.2.3',
    playwright: '1.62.1',
    chromium: '141.0.0.0',
    platform: 'darwin',
  }

  it('finds nothing when the machine is the same one', () => {
    expect(environmentDrift(was, { ...was })).toEqual([])
  })

  it('reports each field that moved, with both values', () => {
    expect(environmentDrift(was, { ...was, chromium: '139.0.0.0', platform: 'linux' })).toEqual([
      { field: 'chromium', was: '141.0.0.0', now: '139.0.0.0' },
      { field: 'platform', was: 'darwin', now: 'linux' },
    ])
  })

  it('has nothing to say without a baseline to compare against', () => {
    expect(environmentDrift(null, was)).toEqual([])
  })

  // An older record has no `chromium` because nothing wrote one, and a run whose browser
  // cannot report a version has none to compare. Neither is a difference.
  it('ignores a field missing from either side', () => {
    expect(environmentDrift({ platform: 'darwin' }, was)).toEqual([])
    expect(environmentDrift(was, { platform: 'darwin' })).toEqual([])
  })
})
