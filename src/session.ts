/**
 * Cookies and local storage, written by `shotlist --login` and read back before a shot,
 * so a recipe can shoot a page that needs an account without holding the password.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ShotlistError, fromRoot, pageMessage, type LoadedConfig } from './config.js'
import { checkPath, checkSession, checkUrl, covers, envFor, hostsFor } from './trust.js'
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

/** Cookies and local storage, in the shape Playwright hands back and takes again. */
export interface StorageState {
  cookies: Array<{ domain?: string } & Record<string, unknown>>
  origins: Array<{ origin?: string } & Record<string, unknown>>
}

/** What narrowing left behind, for the line that says a session lives somewhere else. */
export interface Dropped {
  cookies: number
  origins: number
  /** The hostnames they belonged to, so a missing sign-in names the host to allow. */
  hosts: string[]
}

/** The hosts a session may hold state for: the ones this run is allowed to open. */
export function sessionHosts(loaded: LoadedConfig): readonly string[] {
  return loaded.trust?.hosts ?? hostsFor(loaded.config.site.url, loaded.config.site.allow)
}

/** The hostname of an origin, or an empty string when it is not one — which never matches. */
function hostnameOf(origin: unknown): string {
  if (typeof origin !== 'string') return ''
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

/**
 * Keep the part of a signed-in browser that belongs to this site, and say what it dropped.
 *
 * `storageState()` hands back everything the context collected, and signing in through a
 * provider collects that provider's session too: one OAuth round trip put 41 cookies for
 * google.com, accounts.google.com and youtube.com into a file whose whole purpose was one
 * site's session. Those cookies are the person's actual account rather than a shot list's
 * credential, no shot ever sends them anywhere, and a file holding them is a much larger
 * secret than the one it was written for.
 *
 * Kept is what a run would send to a host it is allowed to open — `site.url` and
 * everything under it, plus `site.allow` — which is the same test `checkUrl` applies to a
 * navigation, so a session covers exactly the site the shot list covers.
 */
export function narrowSession(
  state: unknown,
  hosts: readonly string[],
): { state: StorageState; dropped: Dropped } {
  const raw = (typeof state === 'object' && state !== null ? state : {}) as Partial<StorageState>
  const cookies = Array.isArray(raw.cookies) ? raw.cookies : []
  const origins = Array.isArray(raw.origins) ? raw.origins : []
  const elsewhere = new Set<string>()

  const keptCookies = cookies.filter((cookie) => {
    // A cookie carrying a `Domain` attribute is stored with a leading dot, and it is the
    // name after the dot that has to be this site's.
    const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '') : ''
    // Both directions, unlike every other host check here, because a cookie is shared up
    // and down the domain tree: one set on `example.com` is sent to `app.example.com`, so
    // a shot list covering only the app still needs it, and one set on `api.example.com`
    // is reached by a shot list covering the apex.
    if (domain && hosts.some((host) => covers(host, domain) || covers(domain, host))) return true
    elsewhere.add(domain || '(no domain)')
    return false
  })
  // Local storage is per-origin and shared with nothing, so this is the plain test: the
  // run can only read what it can open.
  const keptOrigins = origins.filter((one) => {
    const host = hostnameOf(one.origin)
    if (host && hosts.some((pattern) => covers(pattern, host))) return true
    elsewhere.add(host || '(no origin)')
    return false
  })

  return {
    state: { cookies: keptCookies, origins: keptOrigins },
    dropped: {
      cookies: cookies.length - keptCookies.length,
      origins: origins.length - keptOrigins.length,
      hosts: [...elsewhere],
    },
  }
}

/**
 * What was left out of a session, in one line.
 *
 * Worth saying rather than doing quietly: a site whose session really does live on
 * another host now signs in and shoots the signed-out page, and the host it needs is the
 * one named here.
 */
function leftOut(dropped: Dropped): string {
  const counted = [
    ...(dropped.cookies ? [`${dropped.cookies} cookie${dropped.cookies === 1 ? '' : 's'}`] : []),
    ...(dropped.origins ? [`${dropped.origins} origin${dropped.origins === 1 ? '' : 's'}`] : []),
  ].join(' and ')
  const named = dropped.hosts.slice(0, 3).join(', ')
  const rest = dropped.hosts.length > 3 ? `, and ${dropped.hosts.length - 3} more` : ''
  return (
    `left out ${counted} for ${named}${rest}, which are not this site — ` +
    'name a host in `site.allow` if signing in needs it.'
  )
}

/** The state Playwright takes, or an error naming the command that writes it. */
export function readSession(loaded: LoadedConfig, session: Session): StorageState {
  if (!existsSync(session.file)) {
    throw new ShotlistError(
      `session "${session.name}": ${session.file} is not there — run ` +
        `\`shotlist --login ${session.name}\` to sign in and write it.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(session.file, 'utf8'))
  } catch {
    throw new ShotlistError(
      `session "${session.name}": ${session.file} is not readable as a session — ` +
        `run \`shotlist --login ${session.name}\` again to replace it.`,
    )
  }
  // A file written before this narrowed anything still holds whatever the sign-in swept
  // up, and loading it hands those cookies back to a browser that will send them.
  return narrowSession(parsed, sessionHosts(loaded)).state
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
    const { state, dropped } = narrowSession(await context.storageState(), sessionHosts(loaded))
    // Anyone holding this file is signed in as that account. `mode` is only honored for a
    // file being created, so an existing one — written at the default umask 0644 by an
    // older version, and readable by every other account on the machine — is set as well.
    writeFileSync(session.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(session.file, 0o600)
    options.say(`  ✓ wrote ${session.file}`)
    if (dropped.cookies || dropped.origins) options.say(`    ${leftOut(dropped)}`)
  } finally {
    await browser.close()
  }
}
