/**
 * Cookies and local storage, written by `shotlist --login` and read back before a shot,
 * so a recipe can shoot a page that needs an account without holding the password.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ShotlistError, fromRoot, pageMessage, type LoadedConfig } from './config.js'
import {
  authorizePath,
  checkPath,
  checkSession,
  checkUrl,
  covers,
  envFor,
  hostsFor,
} from './trust.js'
import { ENV, expandSteps } from './recipe.js'
import type { Library } from './recipe.js'
import { runSteps } from './steps.js'
import type { RunContext } from './steps.js'
import { loadPlaywright } from './playwright.js'
import type { Browser, Page } from './playwright.js'
import type { Run } from './run.js'

/** Whether an input uses the immutable Run interface. */
function isRun(input: Run | LoadedConfig): input is Run {
  return 'project' in input
}

/** A session as the run needs it: where it lives, and what proves it still works. */
export interface Session {
  name: string
  file: string
  verify?: string
  /** Hosts this session keeps cookies for besides the site's own, from `keep`. */
  keep: readonly string[]
}

/** Find a session by name through a Run's authority. */
export function sessionFor(run: Run, name: string, where: string): Session
/** Compatibility interface for callers migrating to the Run seam. */
export function sessionFor(loaded: LoadedConfig, name: string, where: string): Session
/** Resolve and authorize one configured session. */
export function sessionFor(input: Run | LoadedConfig, name: string, where: string): Session {
  const run = isRun(input) ? input : undefined
  const loaded = isRun(input) ? input.project : input
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
  const trust = run?.trust ?? ('trust' in loaded ? loaded.trust : undefined)
  if (trust) checkSession(trust, name, where)
  const authored = fromRoot(loaded, declared.path)
  let file = authored
  if (run) file = authorizePath(run.trust, authored, `site.sessions.${name}`)
  else if (trust) checkPath(trust, authored, `site.sessions.${name}`)
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
export function sessionHosts(run: Run, session: Session): readonly string[]
/** Compatibility interface for callers migrating to the Run seam. */
export function sessionHosts(loaded: LoadedConfig, session: Session): readonly string[]
/** Derive the hosts whose state one session may retain. */
export function sessionHosts(input: Run | LoadedConfig, session: Session): readonly string[] {
  return hostsForSession(input, session)
}

/** Derive session hosts for either side of the compatibility seam. */
function hostsForSession(input: Run | LoadedConfig, session: Session): readonly string[] {
  const run = isRun(input) ? input : undefined
  const loaded = isRun(input) ? input.project : input
  const site =
    run?.trust.hosts ??
    ('trust' in loaded ? loaded.trust?.hosts : undefined) ??
    hostsFor(loaded.config.site.url, loaded.config.site.allow)
  return [...site, ...session.keep]
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
  input: Run | LoadedConfig,
  session: Session,
  state: StorageState,
  dropped: Dropped,
): Promise<void> {
  const site = isRun(input) ? input.project.config.site : input.config.site
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
export function readSession(run: Run, session: Session): StorageState
/** Compatibility interface for callers migrating to the Run seam. */
export function readSession(loaded: LoadedConfig, session: Session): StorageState
/** Read and narrow one authorized session file. */
export function readSession(input: Run | LoadedConfig, candidate: Session): StorageState {
  const run = isRun(input) ? input : undefined
  const session = run ? sessionFor(run, candidate.name, `session "${candidate.name}"`) : candidate
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
  return narrowSession(parsed, hostsForSession(input, session)).state
}

/** Make sure the directory a session is about to be written into exists. */
export function prepareSession(session: Session): void {
  mkdirSync(dirname(session.file), { recursive: true })
}

/** Options shared by manual and scripted login. */
export interface SignInOptions {
  using?: string
  pause?: () => Promise<void>
  say: (line: string) => void
}

/** Sign in to a named Session through a Run. */
export function signIn(run: Run, name: string, options: SignInOptions): Promise<void>
/** Compatibility interface for callers migrating to the Run seam. */
export function signIn(
  loaded: LoadedConfig,
  library: Library,
  session: Session,
  options: SignInOptions,
): Promise<void>
/** Sign in by hand or macro, then narrow and write the authorized Session. */
export async function signIn(
  input: Run | LoadedConfig,
  nameOrLibrary: string | Library,
  sessionOrOptions: Session | SignInOptions,
  legacyOptions?: SignInOptions,
): Promise<void> {
  const run = isRun(input) ? input : undefined
  const loaded = isRun(input) ? input.project : input
  const session = run
    ? sessionFor(run, nameOrLibrary as string, '--login')
    : (sessionOrOptions as Session)
  const options = run ? (sessionOrOptions as SignInOptions) : legacyOptions!
  const library = run ? run.project.library : (nameOrLibrary as Library)
  const { site } = loaded.config
  const trust = run?.trust ?? ('trust' in loaded ? loaded.trust : undefined)
  if (trust) checkUrl(trust, site.url, 'site.url')

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
    const granted = trust?.env ?? []
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
        vars: {
          ...library.data,
          ...(run ? {} : { [ENV]: envFor(trust) }),
        },
        rects: {},
        viewport: site.viewport,
        timeout: site.timeout,
        newPage: () => context.newPage(),
        ...(run ? {} : trust ? { trust } : {}),
      }
      try {
        const steps = expandSteps([{ use: options.using }], library.macros)
        if (run) await runSteps(run, steps, ctx)
        else await runSteps(steps, ctx)
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
    const hosts = hostsForSession(input, session)
    const { state, dropped } = narrowSession(await context.storageState(), hosts)

    // The check above was of the browser, which still holds everything the sign-in
    // collected. What gets written is less than that, and less might not be enough — so
    // the narrowed state is loaded into a context of its own and asked the same question.
    // Before the file is written, so a session that does not work leaves nothing behind.
    if ((dropped.cookies || dropped.origins) && session.verify) {
      await proveSession(browser, input, session, state, dropped)
    }

    // Anyone holding this file is signed in as that account. `mode` is only honored for a
    // file being created, so an existing one — written at the default umask 0644 by an
    // older version, and readable by every other account on the machine — is set as well.
    const file = run
      ? authorizePath(run.trust, session.file, `site.sessions.${session.name}`)
      : session.file
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
