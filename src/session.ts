/**
 * Cookies and local storage, written by `shotlist --login` and read back before a shot,
 * so a recipe can shoot a page that needs an account without holding the password.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ShotlistError, fromRoot, pageMessage } from './config.js'
import { authorizePath, checkSession, checkUrl, covers } from './trust.js'
import { expandSteps } from './recipe.js'
import { runSteps } from './steps.js'
import type { RunContext } from './steps.js'
import { loadPlaywright } from './playwright.js'
import type { Browser, Page } from './playwright.js'
import { assertRun } from './run.js'
import type { Run } from './run.js'

/** A session as the run needs it: where it lives, and what proves it still works. */
export interface Session {
  name: string
  file: string
  verify?: string
  /** Hosts this session keeps cookies for besides the site's own, from `keep`. */
  keep: readonly string[]
}

/** Find a session by name through a Run's authority. */
export function sessionFor(run: Run, name: string, where: string): Session {
  assertRun(run)
  const loaded = run.project
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
  checkSession(run.trust, name, where)
  const authored = fromRoot(loaded, declared.path)
  const file = authorizePath(run.trust, authored, `site.sessions.${name}`)
  return {
    name,
    file,
    keep: declared.keep,
    ...(declared.verify ? { verify: declared.verify } : {}),
  }
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

/**
 * The hosts a session may hold state for.
 *
 * The ones this run is allowed to open, plus whatever the session's own `keep` names —
 * which is the config widening its reach, and safe here because an `--untrusted` run is
 * refused a session by `checkSession` before it ever gets this far.
 */
export function sessionHosts(run: Run, session: Session): readonly string[] {
  assertRun(run)
  return hostsForSession(run, sessionFor(run, session.name, `session "${session.name}"`))
}

/** Derive the hosts whose state one configured Session may retain. */
function hostsForSession(run: Run, session: Session): readonly string[] {
  return [...run.trust.hosts, ...session.keep]
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
 * Kept is what a browser would send to one of `hosts`, which `sessionHosts` builds from
 * the site the run may open and the session's own `keep`.
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
 * What a session left behind, as a phrase.
 *
 * Said rather than done quietly, and said the same way in the report and in the failure:
 * an app whose session really does live on another host is the one case this narrowing
 * breaks, and the host it needs is the one named here.
 */
function leftOut(dropped: Dropped): string {
  const counted = [
    ...(dropped.cookies ? [`${dropped.cookies} cookie${dropped.cookies === 1 ? '' : 's'}`] : []),
    ...(dropped.origins ? [`${dropped.origins} origin${dropped.origins === 1 ? '' : 's'}`] : []),
  ].join(' and ')
  const named = dropped.hosts.slice(0, 3).join(', ')
  const rest = dropped.hosts.length > 3 ? `, and ${dropped.hosts.length - 3} more` : ''
  return `${counted} for ${named}${rest}`
}

/** What `keep` held on to, said every time, because it is somebody's account. */
function kept(session: Session): string {
  return (
    `\`site.sessions.${session.name}.keep\` names ${session.keep.join(', ')}, so this file ` +
    'also holds their cookies — it signs in as whoever those hosts know you as'
  )
}

/**
 * Check the narrowed state still signs in, in a context that holds nothing else.
 *
 * The verify after the sign-in was of a browser carrying everything the round trip
 * collected; this is of what will actually be on disk. An app whose session lives on a
 * host that got dropped passes the first and fails this one, and finding that out here is
 * the difference between one clear error and every shot of the next run being the
 * sign-in form.
 */
async function proveSession(
  browser: Browser,
  run: Run,
  session: Session,
  state: StorageState,
  dropped: Dropped,
): Promise<void> {
  const site = run.project.config.site
  const context = await browser.newContext({ viewport: site.viewport, storageState: state })
  try {
    const page = await context.newPage()
    await page.goto(site.url, { waitUntil: 'load' })
    await page.waitForSelector(session.verify!, { timeout: site.timeout })
  } catch {
    throw new ShotlistError(
      `--login ${session.name}: the sign-in worked and what is left of it does not — ` +
        `"${session.verify}" never appeared at ${site.url} once ${leftOut(dropped)} were ` +
        'left out. ' +
        `If signing in really needs one of them, add it to \`site.sessions.${session.name}.keep\`, ` +
        'knowing the file then holds that account too. Nothing was written.',
    )
  } finally {
    await context.close()
  }
}

/** Read a configured session through a Run's authority. */
export function readSession(run: Run, candidate: Session): StorageState {
  assertRun(run)
  const session = sessionFor(run, candidate.name, `session "${candidate.name}"`)
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
  return narrowSession(parsed, hostsForSession(run, session)).state
}

/** Make sure the directory a Session is about to be written into exists. */
function prepareSession(session: Session): void {
  mkdirSync(dirname(session.file), { recursive: true })
}

/** Options shared by manual and scripted login. */
export interface SignInOptions {
  using?: string
  pause?: () => Promise<void>
  say: (line: string) => void
}

/** Sign in to a named Session through a Run. */
export async function signIn(run: Run, name: string, options: SignInOptions): Promise<void> {
  assertRun(run)
  const loaded = run.project
  const session = sessionFor(run, name, '--login')
  const library = run.project.library
  const { site } = loaded.config
  checkUrl(run.trust, site.url, 'site.url')

  const scripted = options.using !== undefined
  if (!scripted && !options.pause) {
    throw new ShotlistError(
      `--login ${session.name} signs in by hand and there is no terminal to wait in. ` +
        'Give it a macro with `--using <macro>`.',
    )
  }
  if (scripted) {
    // Said before the browser starts, because this run is headless and there is nothing
    // else to look at. Both halves of what it names come from the config — `site.url`
    // picks the host a password is typed into, and `allowEnv` picks which variables it
    // may be typed from — so a config nobody has read gets to choose both, and this line
    // is where that choice becomes visible. The signed-in flow already prints its URL.
    const granted = run.trust.env
    options.say(
      `Signing in at ${site.url} with \`${options.using}\`` +
        (granted.length ? `, which may type ${granted.join(', ')} into it.` : '.'),
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
        vars: { ...library.data },
        rects: {},
        viewport: site.viewport,
        timeout: site.timeout,
        newPage: () => context.newPage(),
      }
      try {
        const steps = expandSteps([{ use: options.using }], library.macros)
        await runSteps(run, steps, ctx)
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
    const hosts = hostsForSession(run, session)
    const { state, dropped } = narrowSession(await context.storageState(), hosts)

    // The check above was of the browser, which still holds everything the sign-in
    // collected. What gets written is less than that, and less might not be enough — so
    // the narrowed state is loaded into a context of its own and asked the same question.
    // Before the file is written, so a session that does not work leaves nothing behind.
    if ((dropped.cookies || dropped.origins) && session.verify) {
      await proveSession(browser, run, session, state, dropped)
    }

    // Anyone holding this file is signed in as that account. `mode` is only honored for a
    // file being created, so an existing one — written at the default umask 0644 by an
    // older version, and readable by every other account on the machine — is set as well.
    const file = authorizePath(run.trust, session.file, `site.sessions.${session.name}`)
    prepareSession({ ...session, file })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
    options.say(`  ✓ wrote ${file}`)
    if (dropped.cookies || dropped.origins) {
      options.say(`    left out ${leftOut(dropped)}, which are not this site`)
      if (!session.verify) {
        options.say(
          `    ! this session has no \`verify\` selector, so nothing checked that what was ` +
            'kept still signs in',
        )
      }
    }
    if (session.keep.length) options.say(`    ! ${kept(session)}`)
  } finally {
    await browser.close()
  }
}
