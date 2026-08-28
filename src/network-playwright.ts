import { ShotlistError } from './config.js'
import type {
  APIResponse,
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Request,
  Route,
  WebSocketRoute,
} from './playwright.js'
import type { NetworkAccess, ReachedDestination } from './network-policy.js'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20

/** Canonicalize one request URL for deciding its next redirect. */
function reached(url: string): ReachedDestination | undefined {
  try {
    const parsed = new URL(url)
    const protocol = parsed.protocol as ReachedDestination['protocol']
    const defaults: Partial<Record<ReachedDestination['protocol'], number>> = {
      'http:': 80,
      'https:': 443,
      'ws:': 80,
      'wss:': 443,
    }
    const port = parsed.port ? Number(parsed.port) : defaults[protocol]
    if (!port) return undefined
    return { protocol, host: parsed.hostname.toLowerCase(), port }
  } catch {
    return undefined
  }
}

/** Headers safe to retain when a manual redirect crosses origins or changes to GET. */
function redirectedHeaders(
  headers: Record<string, string>,
  from: string,
  to: string,
  becameGet: boolean,
): Record<string, string> {
  const next = { ...headers }
  if (new URL(from).origin !== new URL(to).origin) {
    delete next['authorization']
    delete next['proxy-authorization']
    delete next['cookie']
  }
  if (becameGet) {
    delete next['content-length']
    delete next['content-type']
  }
  return next
}

/** Fetch one browser request while authorizing every redirect before sending it. */
async function fetchGuarded(route: Route, access: NetworkAccess): Promise<APIResponse | undefined> {
  const request: Request = route.request()
  let url = request.url()
  let method = request.method()
  let headers = request.headers()
  let postData: Buffer | undefined = request.postDataBuffer() ?? undefined
  let previous: ReachedDestination | undefined

  for (let redirects = 0; ; redirects++) {
    if (!access.record(url, previous)) return undefined
    previous = reached(url)
    const response = await route.fetch({
      url,
      method,
      headers,
      ...(postData ? { postData } : {}),
      maxRedirects: 0,
    })
    if (!REDIRECTS.has(response.status())) return response
    if (redirects >= MAX_REDIRECTS) {
      throw new ShotlistError(`browser request exceeded ${MAX_REDIRECTS} redirects`)
    }
    const location = response.headers()['location']
    if (!location) return response
    const next = new URL(location, url).href
    const becameGet =
      response.status() === 303 ||
      ((response.status() === 301 || response.status() === 302) && method === 'POST')
    headers = redirectedHeaders(headers, url, next, becameGet)
    if (becameGet) {
      method = 'GET'
      postData = undefined
    }
    url = next
  }
}

/** Install Network destination enforcement before the context creates any page. */
async function attach(context: BrowserContext, access: NetworkAccess): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    try {
      const response = await fetchGuarded(route, access)
      if (response) await route.fulfill({ response })
      else await route.abort('blockedbyclient')
    } catch {
      await route.abort('failed')
    }
  })
  // Chromium fails a WebSocket handshake whose server returns a redirect rather than
  // following it. The browser integration test fixes that dependency fact in place.
  await context.routeWebSocket(/.*/, async (socket: WebSocketRoute) => {
    if (access.record(socket.url())) socket.connectToServer()
    else await socket.close({ code: 1008, reason: 'Network destination not approved' })
  })
}

/** Create a browser context whose connections all cross the Network policy seam. */
export async function guardedContext(
  browser: Browser,
  access: NetworkAccess,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' })
  try {
    await attach(context, access)
    return context
  } catch (error) {
    await context.close()
    throw error
  }
}
