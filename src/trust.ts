import { isAbsolute, relative, resolve } from 'node:path'
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
   * The hosts a run may open, always. A shotlist project shoots its own site, so the
   * scope is whatever `site.url` names and everything under it — `site.allow` adds more,
   * and is ignored when the config is not the operator's.
   */
  hosts: readonly string[]
  /**
   * Directories outside the project a run may still read and write, named by the
   * operator with `--allow-path`. Not by the config: the point of the flag is that the
   * config does not get a say.
   */
  paths: readonly string[]
  /** What this project forbids on top of the names shotlist never touches. */
  deny: readonly string[]
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

/** A name that may not be touched, and who said so. */
export interface Forbidden {
  part: string
  /** `shotlist` is the built-in list; `project` is a `deny:` entry or a `--deny` flag. */
  by: 'shotlist' | 'project'
}

/**
 * The part of a path that may not be touched, or null when none of it may not be.
 *
 * Works on a filesystem path and on the path of a URL alike: an administrator saying
 * `/fake-secret` means it whether a recipe reaches it through the disk or through the
 * site. `also` are the project's own additions, which can only ever make this stricter —
 * which is why, unlike `site.allow`, they are honoured even when the config is not
 * trusted. A config widening its reach is a claim; a config narrowing it is not.
 */
export function secretIn(path: string, also: readonly string[] = []): Forbidden | null {
  const extra = also.map(segmentPattern)
  for (const part of path.split(/[\\/]+/).filter(Boolean)) {
    if (SECRET.some((pattern) => pattern.test(part))) return { part, by: 'shotlist' }
    if (extra.some((pattern) => pattern.test(part))) return { part, by: 'project' }
  }
  return null
}

/** How to say a name is off limits, in the terms of whoever put it off limits. */
function refuse(where: string, what: string, found: Forbidden): ShotlistError {
  return new ShotlistError(
    found.by === 'shotlist'
      ? `${where}: ${what} goes through "${found.part}", which shotlist does not read or ` +
          'write in any mode.'
      : `${where}: ${what} goes through "${found.part}", which this project forbids. It is ` +
          'in `deny:` in the config, or in a --deny on the command line, or in ' +
          'SHOTLIST_DENY — ask whoever set it before taking it out.',
  )
}

/** Whether a host is the one named, or something under it. */
function covers(pattern: string, host: string): boolean {
  const wanted = pattern.replace(/^\*\./, '').toLowerCase()
  const found = host.toLowerCase()
  return found === wanted || found.endsWith(`.${wanted}`)
}

/**
 * The hosts a config's own site covers.
 *
 * `rollful.dev` covers `api.rollful.dev`; a `www.` host covers the apex it is the www of,
 * because writing one and meaning the other is the ordinary case rather than a mistake.
 * There is no public-suffix list here, so nothing wider than that is inferred: a second
 * domain is something the config says out loud.
 */
export function hostsFor(siteUrl: string, allow: readonly string[] = []): string[] {
  let host: string
  try {
    host = new URL(siteUrl).hostname
  } catch {
    return [...allow]
  }
  const apex = host.replace(/^www\./i, '')
  return [...new Set([host, apex, ...allow].filter(Boolean))]
}

/** Addresses that are somewhere else on the network the runner happens to sit in. */
const PRIVATE =
  /^(localhost|.*\.localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i

/** Hostnames the big clouds answer credentials on. */
const METADATA = /^(metadata\.google\.internal|metadata\.goog|instance-data)$/i

/**
 * Names forbidden by the environment the run happens in.
 *
 * The config and the command line are both things a recipe author can edit. An
 * administrator setting up a machine or a CI image can set this, and no recipe, config
 * or flag can take it back out.
 */
function denyFromEnv(): string[] {
  return (process.env['SHOTLIST_DENY'] ?? '')
    .split(/[,:]/)
    .map((name) => name.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
}

/** Whether the operator asked for the untrusted rules, from the flag or the environment. */
export function trustFrom(
  where: {
    root: string
    siteUrl: string
    allow?: readonly string[]
    /** The project's own forbidden names, which hold whether it is trusted or not. */
    deny?: readonly string[]
    /** What the operator granted or forbade, which outlives `--untrusted`. */
    granted?: { hosts?: readonly string[]; paths?: readonly string[]; deny?: readonly string[] }
  },
  flag: boolean,
): Trust {
  const fromEnv = process.env['SHOTLIST_UNTRUSTED']
  const untrusted = flag || (fromEnv !== undefined && fromEnv !== '' && fromEnv !== '0')
  // `site.allow` is the config widening its own reach, which is only worth anything when
  // the config is one you wrote. Untrusted, the scope is the site it declared and no more.
  const granted = where.granted ?? {}
  return {
    untrusted,
    root: where.root,
    hosts: hostsFor(where.siteUrl, [
      ...(untrusted ? [] : (where.allow ?? [])),
      ...(granted.hosts ?? []),
    ]),
    paths: (granted.paths ?? []).map((path) => resolve(where.root, path)),
    // Both, always: neither can do anything but refuse more.
    deny: [...(where.deny ?? []), ...(granted.deny ?? []), ...denyFromEnv()],
  }
}

/**
 * Refuse a URL that would make the runner reach somewhere it was not asked to.
 *
 * A config naming a URL is a config choosing what the machine connects to. On a build
 * runner that reaches the cloud's metadata endpoint, an internal admin page, or a
 * database — none of which is reachable from where the config was written.
 *
 * This stops what can be read off the URL. A hostname resolving to a private address is
 * not something a check here can see, so this is a fence, not a boundary: an operator
 * shooting what strangers submit wants a network that cannot reach those either.
 */
export function checkUrl(trust: Trust, url: string, where: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    if (!trust.untrusted) return
    throw new ShotlistError(`${where}: ${url} is not a URL, and this run is --untrusted`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    // A `file:` page is how a project shoots something it has not served, and it reaches
    // no network. Untrusted, it is a way to read the disk, and is refused with the rest.
    if (!trust.untrusted) return
    throw new ShotlistError(
      `${where}: an --untrusted run may only open http(s), and this is ${parsed.protocol.replace(':', '')}`,
    )
  }

  // A project shoots its own site. Wandering off it is a mistake far more often than an
  // intention, and when it is an intention `site.allow` is where it is said.
  if (!trust.hosts.some((pattern) => covers(pattern, parsed.hostname))) {
    throw new ShotlistError(
      `${where}: ${parsed.hostname} is not this site — the shot list covers ` +
        `${trust.hosts.join(', ')} and anything under them. Add it to \`site.allow\` to ` +
        'shoot it too.',
    )
  }

  const forbidden = secretIn(decodeURIComponent(parsed.pathname), trust.deny)
  if (forbidden !== null) throw refuse(where, parsed.pathname, forbidden)

  if (trust.untrusted && (PRIVATE.test(parsed.hostname) || METADATA.test(parsed.hostname))) {
    throw new ShotlistError(
      `${where}: ${parsed.hostname} is on the network the runner sits in, and this run is ` +
        '--untrusted. Only names that resolve outside it may be opened.',
    )
  }
}

/** Refuse a path that holds a secret, or — untrusted — one that leaves the project. */
export function checkPath(trust: Trust, path: string, where: string): void {
  const full = isAbsolute(path) ? path : resolve(trust.root, path)

  // Always, in every mode: these are not things anybody screenshots.
  const secret = secretIn(full, trust.deny)
  if (secret !== null) throw refuse(where, path, secret)

  if (!trust.untrusted) return
  const within = (root: string) => {
    const inside = relative(root, full)
    return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
  }
  if (within(trust.root) || trust.paths.some(within)) return
  throw new ShotlistError(
    `${where}: ${path} is outside the project, and this run is --untrusted. ` +
      'Pass --allow-path to let it out.',
  )
}

/** Refuse to start a process, which is the one thing a strange config must never do. */
export function checkCommand(trust: Trust, where: string): void {
  if (!trust.untrusted) return
  throw new ShotlistError(
    `${where}: an --untrusted run does not start processes. Start the site yourself and ` +
      'point `site.url` at it.',
  )
}
