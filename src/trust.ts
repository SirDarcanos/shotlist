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
}

/** Addresses that are somewhere else on the network the runner happens to sit in. */
const PRIVATE =
  /^(localhost|.*\.localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i

/** Hostnames the big clouds answer credentials on. */
const METADATA = /^(metadata\.google\.internal|metadata\.goog|instance-data)$/i

/** Whether the operator asked for the untrusted rules, from the flag or the environment. */
export function trustFrom(root: string, flag: boolean): Trust {
  const fromEnv = process.env['SHOTLIST_UNTRUSTED']
  return { untrusted: flag || (fromEnv !== undefined && fromEnv !== '' && fromEnv !== '0'), root }
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
  if (!trust.untrusted) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ShotlistError(`${where}: ${url} is not a URL, and this run is --untrusted`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ShotlistError(
      `${where}: an --untrusted run may only open http(s), and this is ${parsed.protocol.replace(':', '')}`,
    )
  }
  if (PRIVATE.test(parsed.hostname) || METADATA.test(parsed.hostname)) {
    throw new ShotlistError(
      `${where}: ${parsed.hostname} is on the network the runner sits in, and this run is ` +
        '--untrusted. Only names that resolve outside it may be opened.',
    )
  }
}

/** Refuse a path that leaves the project, so a run cannot read or write around itself. */
export function checkPath(trust: Trust, path: string, where: string): void {
  if (!trust.untrusted) return
  const full = isAbsolute(path) ? path : resolve(trust.root, path)
  const inside = relative(trust.root, full)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new ShotlistError(`${where}: ${path} is outside the project, and this run is --untrusted`)
  }
}

/** Refuse to start a process, which is the one thing a strange config must never do. */
export function checkCommand(trust: Trust, where: string): void {
  if (!trust.untrusted) return
  throw new ShotlistError(
    `${where}: an --untrusted run does not start processes. Start the site yourself and ` +
      'point `site.url` at it.',
  )
}
