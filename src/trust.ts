import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { ShotlistError } from './config.js'

/**
 * Whether the config being run is the operator's own.
 *
 * shotlist runs in two places, and they are not the same problem. At a desk, the config
 * is a file you wrote in a project you trust, and it is allowed to start your dev server
 * and write images where you keep them. In automation — CI on a fork's pull request, or
 * a service that shoots what somebody submits — the config arrives from outside and the
 * machine running it has credentials, a network position, and other people's work on it.
 *
 * This is set from the command line and the environment, never from the config: a
 * control a config can switch off is not a control.
 */
export interface Trust {
  /** Refuse anything a config should not be able to do to a machine it did not write. */
  untrusted: boolean
  /** The config file's directory: what the filesystem is confined to when untrusted. */
  root: string
  /**
   * Directories outside the project a run may still read and write, named by the
   * operator with `--allow-path`. Not by the config: the point of the flag is that the
   * config does not get a say.
   */
  paths: readonly string[]
  /** What this project forbids on top of the names shotlist never touches. */
  deny: readonly string[]
  /** What a recipe may read as `${env.NAME}`, less anything `SHOTLIST_ENV_DENY` forbids. */
  env: readonly string[]
}

/**
 * Names that are never screenshot material, wherever a run is pointed.
 *
 * Not about trust — a config you wrote has no reason to read your keys either, and a
 * typo in an `install` destination should not be able to write into `.git`. This holds
 * in every mode and there is no flag for it.
 */
const SECRET = [
  /^\.env(\..+)?$/i,
  /^\.git$/i,
  /^\.ssh$/i,
  /^\.gnupg$/i,
  /^\.aws$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.htpasswd$/i,
  /^credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
]

/**
 * A pattern for one segment of a path, where `*` stands for any run of characters.
 *
 * A glob rather than a regular expression on purpose: this is matched against every
 * segment of every path a run touches, and a config supplying its own regex is a config
 * supplying its own backtracking.
 */
function segmentPattern(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === '*' ? '\u0000' : `\\${char}`,
  )
  return new RegExp(`^${escaped.replace(/\u0000/g, '[^/\\\\]*')}$`, 'i')
}

/**
 * The part of a path that may not be touched, or null when none of it may not be.
 *
 * Works on a filesystem path and on the path of a URL alike: an administrator saying
 * `/fake-secret` means it whether a recipe reaches it through the disk or through the
 * site. `also` are the project's own additions, which can only ever make this stricter —
 * which is why, unlike `site.allow`, they are honored even when the config is not
 * trusted. A config widening its reach is a claim; a config narrowing it is not.
 */
export function secretIn(path: string, also: readonly string[] = []): string | null {
  const patterns = [...SECRET, ...also.map(segmentPattern)]
  for (const part of path.split(/[\\/]+/).filter(Boolean)) {
    // A null byte ends the string for whatever opens the path next, so `.env\0.png` is
    // `.env` to the filesystem and something else to a comparison. Match what it will be.
    const seen = part.split('\u0000')[0]!
    if (patterns.some((pattern) => pattern.test(seen))) return seen
  }
  return null
}

/**
 * Say a name is off limits, and stop.
 *
 * Not where it was set, and not whether shotlist or the project set it: whoever reads
 * this cannot act on either, and naming the config key mostly invites editing it out —
 * which is the opposite of the point. One sentence, and who to take it up with.
 */
function refuse(where: string, part: string): ShotlistError {
  return new ShotlistError(`${where}: "${part}" is a forbidden path — contact the administrator`)
}

/** Whether a host is the one named, or something under it. */
export function covers(pattern: string, host: string): boolean {
  const wanted = pattern.replace(/^\*\./, '').toLowerCase()
  const found = host.toLowerCase()
  return found === wanted || found.endsWith(`.${wanted}`)
}

/** A character no path or URL has a reason to carry, and that hides what follows it. */
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Names forbidden by the environment the run happens in.
 *
 * The config and the command line are both things a recipe author can edit. An
 * administrator setting up a machine or a CI image can set this, and no recipe, config
 * or flag can take it back out.
 */
function denyFromEnv(environment: Readonly<Record<string, string | undefined>>): string[] {
  return (environment['SHOTLIST_DENY'] ?? '')
    .split(/[,:]/)
    .map((name) => name.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
}

/** Whether the operator asked for the untrusted rules, from the flag or the environment. */
export interface TrustSource {
  root: string
  siteUrl: string
  allow?: readonly string[]
  /** The project's own forbidden names, which hold whether it is trusted or not. */
  deny?: readonly string[]
  /** Variable names the config asks for, which only a trusted one gets. */
  allowEnv?: readonly string[]
  /** What the operator granted or forbade, which outlives `--untrusted`. */
  granted?: {
    paths?: readonly string[]
    deny?: readonly string[]
    env?: readonly string[]
  }
}

/** Derive one Run's policy from an environment snapshot. */
export function trustFromEnvironment(
  where: TrustSource,
  flag: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): Trust {
  const fromEnv = environment['SHOTLIST_UNTRUSTED']
  const untrusted = flag || (fromEnv !== undefined && fromEnv !== '' && fromEnv !== '0')
  // `site.allow` is the config widening its own reach, which is only worth anything when
  // the config is one you wrote. Untrusted, the scope is the site it declared and no more.
  const granted = where.granted ?? {}
  const forbiddenEnv = envDenyFromEnv(environment)
  return {
    untrusted,
    root: where.root,
    paths: (granted.paths ?? []).map((path) => resolve(where.root, path)),
    // Both, always: neither can do anything but refuse more.
    deny: [...(where.deny ?? []), ...(granted.deny ?? []), ...denyFromEnv(environment)],
    // Dropped whole rather than narrowed: a partial grant reads like a safe one. The
    // config's own list is widening, so it goes the way `site.allow` goes.
    env: (untrusted
      ? []
      : [...(where.allowEnv ?? []), ...(granted.env ?? []), ...envFromEnv(environment)]
    ).filter((name) => !forbiddenEnv.some((pattern) => pattern.test(name))),
  }
}

/** Derive policy from the machine's current environment for focused policy callers. */
export function trustFrom(where: TrustSource, flag: boolean): Trust {
  return trustFromEnvironment(where, flag, process.env)
}

/**
 * Variable names this machine will not hand a recipe, whatever allowed them.
 *
 * The counterpart of `SHOTLIST_DENY`, subtracted last, so an administrator building a CI
 * image can put a name out of reach and no config key or flag adds it back. Globs, the
 * same as the path list: `AWS_*` and `*_TOKEN` both work.
 *
 * A fence, not a boundary. It stops `--allow-env AWS_SECRET_KEY`; it does nothing about
 * `echo $AWS_SECRET_KEY` on the same machine, because the shell of whoever runs a command
 * was never something a screenshot tool could stand in front of. It is worth having where
 * shotlist is close to the only thing that runs — a container built to shoot configs that
 * came from somewhere else — and worth nothing as a control over a person at a terminal.
 */
function envDenyFromEnv(environment: Readonly<Record<string, string | undefined>>): RegExp[] {
  return (environment['SHOTLIST_ENV_DENY'] ?? '')
    .split(/[,:\s]+/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map(segmentPattern)
}

/** Names granted through `SHOTLIST_ENV`, for CI that sets its secrets there anyway. */
function envFromEnv(environment: Readonly<Record<string, string | undefined>>): string[] {
  return (environment['SHOTLIST_ENV'] ?? '')
    .split(/[,:\s]+/)
    .map((name) => name.trim())
    .filter(Boolean)
}

/** The values a recipe may interpolate. An empty one is left out, so it fails as unset. */
export function envFor(trust: Trust | undefined): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of trust?.env ?? []) {
    const value = process.env[name]
    if (value !== undefined && value !== '') values[name] = value
  }
  return values
}

/** Refuse a session to a config that is not the operator's: it is a credential. */
export function checkSession(trust: Trust, name: string, where: string): void {
  if (!trust.untrusted) return
  throw new ShotlistError(
    `${where}: an --untrusted run does not load sessions, and this one asks for "${name}". ` +
      'Shoot what does not need signing in, or run it without --untrusted.',
  )
}

/**
 * A path with every link along it followed, as far as it exists.
 *
 * A destination is usually a directory that has not been made yet, so this climbs to the
 * nearest part that does exist and resolves that: what is not there cannot be a link.
 */
function realpathOf(path: string, followed = new Set<string>()): string {
  let here = path
  const rest: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(here), ...rest.reverse())
    } catch {
      try {
        if (lstatSync(here).isSymbolicLink()) {
          if (followed.has(here)) return path
          followed.add(here)
          const target = resolve(dirname(here), readlinkSync(here), ...[...rest].reverse())
          return realpathOf(target, followed)
        }
      } catch {
        // This component does not exist; its nearest existing ancestor decides policy.
      }
      const up = dirname(here)
      if (up === here) return path
      rest.push(basename(here))
      here = up
    }
  }
}

declare const authorizedPath: unique symbol

/** A canonical path returned by the policy gateway for an immediate filesystem effect. */
export type AuthorizedPath = string & { readonly [authorizedPath]: true }

/** Authorize a path and return the canonical target that the caller may touch. */
export function authorizePath(trust: Trust, path: string, where: string): AuthorizedPath {
  if (CONTROL.test(path)) {
    throw new ShotlistError(`${where}: ${JSON.stringify(path)} holds a control character`)
  }
  const full = isAbsolute(path) ? path : resolve(trust.root, path)

  // Check both spellings. A harmless-looking link can point at a secret name, and trusted
  // mode does not make `.env` or `.git` screenshot material.
  const lexicalSecret = secretIn(full, trust.deny)
  if (lexicalSecret !== null) throw refuse(where, lexicalSecret)
  const real = realpathOf(full)
  const targetSecret = secretIn(real, trust.deny)
  if (targetSecret !== null) throw refuse(where, targetSecret)

  if (trust.untrusted) {
    const within = (root: string) => {
      const inside = relative(realpathOf(root), real)
      return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
    }
    if (!within(trust.root) && !trust.paths.some(within)) {
      throw new ShotlistError(
        `${where}: ${path} is outside the project, and this run is --untrusted. ` +
          'Pass --allow-path to let it out.',
      )
    }
  }
  return real as AuthorizedPath
}

/** Refuse a path that holds a secret, or — untrusted — one that leaves the project. */
export function checkPath(trust: Trust, path: string, where: string): void {
  authorizePath(trust, path, where)
}

/** Refuse to start a process, which is the one thing a strange config must never do. */
export function checkCommand(trust: Trust, where: string): void {
  if (!trust.untrusted) return
  throw new ShotlistError(
    `${where}: an --untrusted run does not start processes. Start the site yourself and ` +
      'point `site.url` at it.',
  )
}
