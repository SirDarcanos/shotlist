import { describe, expect, it } from 'vitest'
import { compileNetworkPolicy } from '../src/network-policy.js'
import { guardedContext } from '../src/network-playwright.js'
import type { BrowserContextOptions, Route, WebSocketRoute } from '../src/playwright.js'

/** A browser adapter that exposes installed handlers as scripted request events. */
function fakeBrowser() {
  let requestHandler: ((route: Route) => Promise<void>) | undefined
  let socketHandler: ((route: WebSocketRoute) => Promise<void>) | undefined
  let options: BrowserContextOptions | undefined
  const context = {
    newPage: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
    storageState: () => Promise.resolve({}),
    route: (_pattern: string | RegExp, handler: (route: Route) => Promise<void>) => {
      requestHandler = handler
      return Promise.resolve()
    },
    routeWebSocket: (
      _pattern: string | RegExp,
      handler: (route: WebSocketRoute) => Promise<void>,
    ) => {
      socketHandler = handler
      return Promise.resolve()
    },
  }
  return {
    browser: {
      newContext: (input?: BrowserContextOptions) => {
        options = input
        return Promise.resolve(context)
      },
      close: () => Promise.resolve(),
    },
    options: () => options,
    request: async (url: string) => {
      const actions: string[] = []
      await requestHandler!({
        request: () => ({
          url: () => url,
          method: () => 'GET',
          headers: () => ({}),
          postDataBuffer: () => null,
          redirectedFrom: () => null,
        }),
        fetch: () => {
          actions.push('fetch')
          return Promise.resolve({ status: () => 200, headers: () => ({}) })
        },
        fulfill: () => {
          actions.push('fulfill')
          return Promise.resolve()
        },
        continue: () => {
          actions.push('continue')
          return Promise.resolve()
        },
        abort: () => {
          actions.push('abort')
          return Promise.resolve()
        },
      })
      return actions
    },
    socket: async (url: string) => {
      const actions: string[] = []
      await socketHandler!({
        url: () => url,
        connectToServer: () => actions.push('connect'),
        close: () => {
          actions.push('close')
          return Promise.resolve()
        },
      })
      return actions
    },
  }
}

describe('Playwright Network destination enforcement', () => {
  it('attaches before pages exist, blocks service workers, and handles requests and WebSockets', async () => {
    const fake = fakeBrowser()
    const policy = compileNetworkPolicy({
      operator: ['assets.example.com', 'wss://live.example.com:443'],
      project: [],
      untrusted: true,
      deny: [],
    })
    const access = policy.forRecipe('home')

    await guardedContext(fake.browser, access, { viewport: { width: 800, height: 600 } })

    expect(fake.options()).toMatchObject({ serviceWorkers: 'block' })
    expect(await fake.request('https://assets.example.com/app.js')).toEqual(['fetch', 'fulfill'])
    expect(await fake.request('https://blocked.example.com/pixel?secret=value')).toEqual(['abort'])
    expect(await fake.socket('wss://live.example.com/socket')).toEqual(['connect'])
    expect(await fake.socket('wss://blocked.example.com/socket?token=secret')).toEqual(['close'])
    expect(() => access.throwIfBlocked()).toThrow(
      /https:\/\/blocked\.example\.com.*wss:\/\/blocked\.example\.com/,
    )
  })
})
