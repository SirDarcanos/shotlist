import { ShotlistError } from './config.js'
import { secretIn } from './trust.js'

export type NetworkProtocol = 'http:' | 'https:' | 'ws:' | 'wss:' | 'tcp:'

/** One canonical Network destination approval. */
export interface NetworkDestination {
  readonly protocol: NetworkProtocol
  readonly host: string
  readonly port: number
  readonly subdomains: boolean
}

/** A destination reached by an approved request, for deciding its redirect. */
export interface ReachedDestination {
  readonly protocol: NetworkProtocol
  readonly host: string
  readonly port: number
}

/** A policy failure containing only sanitized Network destinations. */
export class NetworkPolicyError extends ShotlistError {
  readonly blocked: readonly string[]
  readonly omitted: number

  constructor(label: string, blocked: readonly string[], omitted = 0, reason?: string) {
    const listed = blocked.join(', ')
    const more = omitted ? `, and ${omitted} more` : ''
    super(
      reason ??
        `${label}: Network destination${blocked.length === 1 ? '' : 's'} ${listed}${more} ` +
          `${blocked.length === 1 ? 'is' : 'are'} not approved. Approve each through Operator ` +
          'authority. No screenshot was taken.',
    )
    this.blocked = blocked
    this.omitted = omitted
  }
}

/** Network access scoped to one Recipe attempt or shotlist-owned operation. */
export interface NetworkAccess {
  check(candidate: string, redirectedFrom?: ReachedDestination): ReachedDestination | undefined
  record(candidate: string, redirectedFrom?: ReachedDestination): boolean
  throwIfBlocked(): void
}

/** One Run's compiled and immutable Network destination policy. */
export interface NetworkPolicy {
  readonly operatorDestinations: readonly NetworkDestination[]
  readonly effectiveDestinations: readonly NetworkDestination[]
  forRecipe(name: string): NetworkAccess
  forOperation(label: string): NetworkAccess
}

interface CompileInput {
  operator: readonly string[]
  project: readonly string[]
  untrusted: boolean
  deny: readonly string[]
}

const DEFAULT_PORT: Partial<Record<NetworkProtocol, number>> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
}
const EXTERNAL = new Set<NetworkProtocol>(['http:', 'https:', 'ws:', 'wss:', 'tcp:'])
const MAX_BLOCKED = 20

/** Parse one authored approval into a canonical Network destination. */
function parseApproval(authored: string): NetworkDestination {
  const value = authored.trim()
  const wildcard = value.startsWith('*.')
  const input = wildcard ? value.slice(2) : value
  const shorthand = !input.includes('://')
  if (!input || (shorthand && input.includes(':')) || (!wildcard && input.includes('*'))) {
    throw invalidApproval(authored)
  }
  let parsed: URL
  try {
    parsed = new URL(shorthand ? `https://${input}` : input)
  } catch {
    throw invalidApproval(authored)
  }
  const protocol = parsed.protocol as NetworkProtocol
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT[protocol]
  if (
    !EXTERNAL.has(protocol) ||
    (protocol === 'tcp:' && (shorthand || !parsed.port)) ||
    !port ||
    parsed.username ||
    parsed.password ||
    (protocol === 'tcp:' ? parsed.pathname !== '' : parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname ||
    parsed.hostname.includes('*') ||
    (wildcard && !shorthand)
  ) {
    throw invalidApproval(authored)
  }
  return Object.freeze({
    protocol,
    host: parsed.hostname.toLowerCase(),
    port,
    subdomains: wildcard,
  })
}

/** Report the accepted approval shapes without echoing possible credentials. */
function invalidApproval(_authored: string): ShotlistError {
  return new ShotlistError(
    'Network destination approval is invalid. Use a host for HTTPS port 443, ' +
      '`*.example.com` for HTTPS subdomains, a full http(s) destination for another port, ' +
      'or `tcp://host:port` for TCP readiness.',
  )
}

/** Canonicalize a request URL without retaining its path, query, fragment, or credentials. */
function destinationOf(candidate: string): ReachedDestination | undefined {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  const protocol = parsed.protocol as NetworkProtocol
  if (!EXTERNAL.has(protocol)) return undefined
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT[protocol]
  if (!port || !parsed.hostname) return undefined
  return { protocol, host: parsed.hostname.toLowerCase(), port }
}

/** Render only protocol, host, and a non-default port. */
function sanitized(candidate: string): string {
  const destination = destinationOf(candidate)
  if (!destination) {
    try {
      return `${new URL(candidate).protocol || 'invalid:'}//(invalid destination)`
    } catch {
      return 'invalid://(invalid destination)'
    }
  }
  const standard = DEFAULT_PORT[destination.protocol] === destination.port
  return `${destination.protocol}//${destination.host}${standard ? '' : `:${destination.port}`}`
}

/** Decode a URL path to a fixed point so a second server decode cannot reveal a secret. */
function decodedPath(pathname: string): string | undefined {
  let value = pathname
  for (let depth = 0; depth < 8; depth++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(value)
    } catch {
      return undefined
    }
    if (decoded === value) return value
    value = decoded
  }
  // Eight nested encodings have no ordinary URL use and may still hide another layer.
  return undefined
}

/** Whether an approval covers an exact canonical destination. */
function matches(approval: NetworkDestination, destination: ReachedDestination): boolean {
  const host = approval.subdomains
    ? destination.host.endsWith(`.${approval.host}`) && destination.host !== approval.host
    : destination.host === approval.host
  return host && approval.protocol === destination.protocol && approval.port === destination.port
}

/** Remove duplicate canonical approvals while retaining declaration order. */
function unique(approvals: readonly NetworkDestination[]): readonly NetworkDestination[] {
  const seen = new Set<string>()
  return Object.freeze(
    approvals.filter((approval) => {
      const key = `${approval.protocol}|${approval.host}|${approval.port}|${approval.subdomains}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  )
}

/** Compile one Run's Network destination approvals and access scopes. */
export function compileNetworkPolicy(input: CompileInput): NetworkPolicy {
  const operatorDestinations = unique(input.operator.map(parseApproval))
  const projectDestinations = input.untrusted ? [] : input.project.map(parseApproval)
  const effectiveDestinations = unique([...operatorDestinations, ...projectDestinations])

  /** Create one failure-latched and bounded access scope. */
  const scope = (label: string, applicationRecipe: boolean): NetworkAccess => {
    const blocked: string[] = []
    const seen = new Set<string>()
    let omitted = 0

    /** Decide one candidate without exposing its sensitive URL parts. */
    const decide = (
      candidate: string,
      redirectedFrom?: ReachedDestination,
    ): { allowed: boolean; destination?: ReachedDestination; reason?: string } => {
      let parsed: URL
      try {
        parsed = new URL(candidate)
      } catch {
        return { allowed: false, reason: `${label}: request URL is invalid` }
      }
      if (parsed.username || parsed.password) {
        return { allowed: false, reason: `${label}: a request URL contains a username or password` }
      }
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return { allowed: true }
      if (parsed.protocol === 'file:') {
        return {
          allowed: !applicationRecipe,
          reason: `${label}: an Application Recipe cannot navigate to a local file`,
        }
      }
      const destination = destinationOf(candidate)
      if (!destination)
        return { allowed: false, reason: `${label}: request protocol is unsupported` }

      const pathname = decodedPath(parsed.pathname)
      if (pathname === undefined) {
        return { allowed: false, reason: `${label}: request path has invalid nested encoding` }
      }
      if (/[\u0000-\u001f\u007f]/.test(pathname)) {
        return { allowed: false, reason: `${label}: request path holds a control character` }
      }
      const forbidden = secretIn(pathname, input.deny)
      if (forbidden) {
        return { allowed: false, reason: `${label}: "${forbidden}" is a forbidden path` }
      }
      if (effectiveDestinations.some((approval) => matches(approval, destination))) {
        return { allowed: true, destination }
      }
      if (
        redirectedFrom?.protocol === 'http:' &&
        destination.protocol === 'https:' &&
        destination.host === redirectedFrom.host &&
        destination.port === 443
      ) {
        return { allowed: true, destination }
      }
      return { allowed: false, destination }
    }

    /** Add one sanitized violation without letting repeated traffic fill the bound. */
    const addBlocked = (candidate: string) => {
      const safe = sanitized(candidate)
      if (seen.has(safe)) return
      seen.add(safe)
      if (blocked.length < MAX_BLOCKED) blocked.push(safe)
      else omitted++
    }

    const failure = (reason?: string) => new NetworkPolicyError(label, blocked, omitted, reason)
    return {
      check(candidate, redirectedFrom) {
        if (blocked.length || omitted) throw failure()
        const decision = decide(candidate, redirectedFrom)
        if (!decision.allowed) {
          addBlocked(candidate)
          throw failure(decision.reason)
        }
        return decision.destination
      },
      record(candidate, redirectedFrom) {
        const decision = decide(candidate, redirectedFrom)
        if (decision.allowed) return true
        addBlocked(candidate)
        return false
      },
      throwIfBlocked() {
        if (blocked.length || omitted) throw failure()
      },
    }
  }

  return Object.freeze({
    operatorDestinations,
    effectiveDestinations,
    forRecipe: (name: string) => scope(`recipe "${name}"`, true),
    forOperation: (label: string) => scope(label, false),
  })
}
