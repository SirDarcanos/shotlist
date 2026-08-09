/**
 * Cookies and local storage, written by `shotlist --login` and read back before a shot,
 * so a recipe can shoot a page that needs an account without holding the password.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ShotlistError, fromRoot, pageMessage, type LoadedConfig } from './config.js'
import { checkPath, checkSession, checkUrl, envFor } from './trust.js'
import { ENV, expandSteps } from './recipe.js'
import type { Library } from './recipe.js'
import { runSteps } from './steps.js'
import type { RunContext } from './steps.js'
import { loadPlaywright } from './playwright.js'
import type { Page } from './playwright.js'

/** A session as the run needs it: where it lives, and what proves it still works. */
export interface Session {
  name: string
  file: string
  verify?: string
}

/** Find a session by name, with the path checked the way every other path is. */
export function sessionFor(loaded: LoadedConfig, name: string, where: string): Session {
  const declared = loaded.config.site.sessions[name]
  if (!declared) {
    const known = Object.keys(loaded.config.site.sessions)
    throw new ShotlistError(
      `${where}: no session named "${name}" — ` +
        (known.length
          ? `\`site.sessions\` has ${known.map((one) => `"${one}"`).join(', ')}`
          : '`site.sessions` is empty. Declare one, then run `shotlist --login ' + `${name}\`.`),
    )
  }
  if (loaded.trust) checkSession(loaded.trust, name, where)
  const file = fromRoot(loaded, declared.path)
  if (loaded.trust) checkPath(loaded.trust, file, `site.sessions.${name}`)
  return { name, file, ...(declared.verify ? { verify: declared.verify } : {}) }
}

/** The state Playwright takes, or an error naming the command that writes it. */
export function readSession(session: Session): unknown {
  if (!existsSync(session.file)) {
    throw new ShotlistError(
      `session "${session.name}": ${session.file} is not there — run ` +
        `\`shotlist --login ${session.name}\` to sign in and write it.`,
    )
  }
  try {
    return JSON.parse(readFileSync(session.file, 'utf8'))
  } catch {
    throw new ShotlistError(
      `session "${session.name}": ${session.file} is not readable as a session — ` +
        `run \`shotlist --login ${session.name}\` again to replace it.`,
    )
  }
}

/** Make sure the directory a session is about to be written into exists. */
export function prepareSession(session: Session): void {
  mkdirSync(dirname(session.file), { recursive: true })
}

/** Sign in — by hand, or with a macro when nobody is at the keyboard — and write it. */
export async function signIn(
  loaded: LoadedConfig,
  library: Library,
  session: Session,
  options: { using?: string; pause?: () => Promise<void>; say: (line: string) => void },
): Promise<void> {
  const { site } = loaded.config
  if (loaded.trust) checkUrl(loaded.trust, site.url, 'site.url')
  prepareSession(session)

  const scripted = options.using !== undefined
  if (!scripted && !options.pause) {
    throw new ShotlistError(
      `--login ${session.name} signs in by hand and there is no terminal to wait in. ` +
        'Give it a macro with `--using <macro>`.',
    )
  }
  const browser = await loadPlaywright().chromium.launch({ headless: scripted })
  try {
    const context = await browser.newContext({ viewport: site.viewport })
    const page = await context.newPage()
    try {
      await page.goto(site.url, { waitUntil: 'load' })
    } catch (error) {
      throw new ShotlistError(
        `--login ${session.name}: could not open ${site.url} — ${pageMessage(error)}. ` +
          'Is the site running?',
      )
    }

    if (options.using !== undefined) {
      const ctx: RunContext = {
        pages: new Map<string, Page>([['main', page]]),
        page,
        vars: { ...library.data, [ENV]: envFor(loaded.trust) },
        rects: {},
        viewport: site.viewport,
        timeout: site.timeout,
        newPage: () => context.newPage(),
        ...(loaded.trust ? { trust: loaded.trust } : {}),
      }
      try {
        await runSteps(expandSteps([{ use: options.using }], library.macros), ctx)
      } catch (error) {
        throw new ShotlistError(
          `--login ${session.name}: \`${options.using}\` — ${pageMessage(error)}`,
        )
      }
    } else {
      options.say(`A browser is open at ${site.url}. Sign in there, then press Enter here.`)
      await options.pause!()
    }

    // A session saved from a failed sign-in exists, reads back fine, and shoots the form.
    if (session.verify) {
      try {
        await page.waitForSelector(session.verify, { timeout: site.timeout })
      } catch {
        throw new ShotlistError(
          `--login ${session.name}: "${session.verify}" never appeared, so this does not ` +
            'look signed in. Nothing was written.',
        )
      }
    }
    await context.storageState({ path: session.file })
    options.say(`  ✓ wrote ${session.file}`)
  } finally {
    await browser.close()
  }
}
