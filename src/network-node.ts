import { createConnection } from 'node:net'
import { ShotlistError } from './config.js'
import type { NetworkAccess, ReachedDestination } from './network-policy.js'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 10

/** The Node network effects used by readiness checks. */
export interface NodeNetworkAdapter {
  request(url: string): Promise<{ status: number; location?: string }>
  connect(host: string, port: number): Promise<boolean>
}

/** Production Node HTTP and TCP effects behind the Network policy seam. */
const NODE_NETWORK: NodeNetworkAdapter = {
  async request(url) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    })
    const location = response.headers.get('location')
    return { status: response.status, ...(location ? { location } : {}) }
  },
  connect(host, port) {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host })
      const settle = (answer: boolean) => {
        socket.destroy()
        resolve(answer)
      }
      socket.setTimeout(2000)
      socket.once('connect', () => settle(true))
      socket.once('timeout', () => settle(false))
      socket.once('error', () => settle(false))
    })
  },
}

/** Probe an HTTP(S) destination while authorizing every redirect hop. */
export async function answers(
  access: NetworkAccess,
  initial: string,
  adapter: NodeNetworkAdapter = NODE_NETWORK,
): Promise<boolean> {
  let url = initial
  let previous: ReachedDestination | undefined
  try {
    for (let redirects = 0; ; redirects++) {
      previous = access.check(url, previous)
      const response = await adapter.request(url)
      if (!REDIRECTS.has(response.status)) return true
      if (redirects >= MAX_REDIRECTS) {
        throw new ShotlistError(`readiness request exceeded ${MAX_REDIRECTS} redirects`)
      }
      if (!response.location) return true
      url = new URL(response.location, url).href
    }
  } catch (error) {
    access.throwIfBlocked()
    if (error instanceof ShotlistError) throw error
    return false
  }
}

/** Probe one exact TCP Network destination. */
export function accepts(
  access: NetworkAccess,
  host: string,
  port: number,
  adapter: NodeNetworkAdapter = NODE_NETWORK,
): Promise<boolean> {
  access.check(`tcp://${host}:${port}`)
  return adapter.connect(host, port)
}
