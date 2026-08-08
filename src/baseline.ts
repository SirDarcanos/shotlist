import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ShotlistError } from './config.js'
import type { LoadedConfig } from './config.js'
import type { Browser } from './playwright.js'

/**
 * What the committed images were taken with.
 *
 * Everything here changes what a screenshot looks like without the site changing at all:
 * a different Chromium rasterises text differently, and a different platform has
 * different faces to rasterise. `--check` compares pixels, so without this a project is
 * told 0.83% of them moved and left to guess whether that was the app or the machine.
 */
export interface Environment {
  shotlist?: string
  playwright?: string
  chromium?: string
  platform?: string
}

/** The file recording it, beside the config so it is committed with the images. */
export const BASELINE_FILE = 'shotlist.baseline.json'

/** A package's version, or undefined when it cannot be resolved from here. */
function versionOf(specifier: string): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return (require(specifier) as { version?: string }).version
  } catch {
    return undefined
  }
}

/** Describe the machine this run is happening on. */
export function describeEnvironment(browser?: Browser): Environment {
  return {
    shotlist: versionOf('../package.json'),
    playwright: versionOf('playwright/package.json'),
    // A fake browser in a test has no version, and neither does a run that never
    // launched one — the field is left out rather than guessed at.
    chromium: browser?.version?.(),
    platform: process.platform,
  }
}

/** Where the record lives for a given project. */
export function baselineFile(loaded: Pick<LoadedConfig, 'root'>): string {
  return join(loaded.root, BASELINE_FILE)
}

/** Record what this run was taken with, beside the config. */
export function writeBaseline(loaded: Pick<LoadedConfig, 'root'>, environment: Environment): void {
  writeFileSync(baselineFile(loaded), `${JSON.stringify(environment, null, 2)}\n`)
}

/** Read the record, or null when a project has never installed anything. */
export function readBaseline(loaded: Pick<LoadedConfig, 'root'>): Environment | null {
  const file = baselineFile(loaded)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Environment
  } catch (error) {
    throw new ShotlistError((error as Error).message, file)
  }
}

/** One entry per field that has moved since the baseline was taken. */
export interface Drift {
  field: keyof Environment
  was: string
  now: string
}

/**
 * What has changed since the committed images were taken.
 *
 * A field missing from either side is not a difference: an older record has no `chromium`
 * because nothing wrote one, and a run using a browser that cannot report its version has
 * nothing to compare. Neither is worth a warning.
 */
export function environmentDrift(was: Environment | null, now: Environment): Drift[] {
  if (!was) return []
  const fields: (keyof Environment)[] = ['shotlist', 'playwright', 'chromium', 'platform']
  return fields.flatMap((field) => {
    const before = was[field]
    const after = now[field]
    if (!before || !after || before === after) return []
    return [{ field, was: before, now: after }]
  })
}
