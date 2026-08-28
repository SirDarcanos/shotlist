import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRun, shoot } from '../src/index.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Listen on a random local port and return its exact HTTP Network destination. */
async function listen(body: (origin: string) => string): Promise<string> {
  const server = createServer((_, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(body(origin))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  return origin
}

describe('browser Network destination enforcement', () => {
  it('blocks a page subrequest and writes no Output image', { timeout: 120_000 }, async () => {
    const blocked = await listen(() => '<p>should not load</p>')
    const main = await listen(
      () => `<main>Page</main><img src="${blocked}/pixel?token=must-not-appear#secret">`,
    )
    const root = mkdtempSync(join(tmpdir(), 'shotlist-network-browser-'))
    roots.push(root)
    mkdirSync(join(root, 'recipes'))
    writeFileSync(
      join(root, 'shotlist.config.json'),
      JSON.stringify({
        site: { url: `${main}/` },
        paths: { recipes: 'recipes', out: 'out' },
      }),
    )
    writeFileSync(join(root, 'recipes/home.json'), JSON.stringify({ name: 'home' }))
    const run = openRun(
      { untrusted: true, destinations: [main] },
      join(root, 'shotlist.config.json'),
    )
    const recipe = run.project.library.recipes.get('home')!

    const error = await shoot(run, recipe).then(
      () => new Error('the Recipe was expected to fail'),
      (failure: Error) => failure,
    )
    expect(error.message).toMatch(
      new RegExp(`Network destination http:\\/\\/127\\.0\\.0\\.1:${new URL(blocked).port}`),
    )
    expect(error.message).not.toMatch(/token|must-not-appear|secret/)
    expect(existsSync(join(root, 'out/home.png'))).toBe(false)
  })

  it('authorizes a browser redirect target before following it', { timeout: 120_000 }, async () => {
    let reached = 0
    const blocked = await listen(() => {
      reached++
      return '<p>blocked</p>'
    })
    let main = ''
    const server = createServer((request, response) => {
      if (request.url === '/jump') {
        response.statusCode = 302
        response.setHeader('location', `${blocked}/image?token=hidden`)
        response.end()
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(`<main>Page</main><img src="${main}/jump">`)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    main = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const root = mkdtempSync(join(tmpdir(), 'shotlist-network-browser-'))
    roots.push(root)
    mkdirSync(join(root, 'recipes'))
    writeFileSync(
      join(root, 'shotlist.config.json'),
      JSON.stringify({
        site: { url: `${main}/`, settle: 200 },
        paths: { recipes: 'recipes', out: 'out' },
      }),
    )
    writeFileSync(join(root, 'recipes/home.json'), JSON.stringify({ name: 'home' }))
    const run = openRun(
      { untrusted: true, destinations: [main] },
      join(root, 'shotlist.config.json'),
    )

    const outcome = await shoot(run, run.project.library.recipes.get('home')!).catch(
      (error: Error) => error,
    )
    expect(reached).toBe(0)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/Network destination/)
  })

  it(
    'blocks service workers before they can make unrouteable requests',
    { timeout: 120_000 },
    async () => {
      let workerRequests = 0
      const server = createServer((request, response) => {
        if (request.url === '/sw.js') {
          workerRequests++
          response.setHeader('content-type', 'text/javascript')
          response.end("fetch('https://blocked.example/private')")
          return
        }
        response.setHeader('content-type', 'text/html')
        response.end(
          "<main>Page</main><script>navigator.serviceWorker.register('/sw.js').catch(()=>{})</script>",
        )
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      const origin = `http://127.0.0.1:${port}`
      const root = mkdtempSync(join(tmpdir(), 'shotlist-network-browser-'))
      roots.push(root)
      mkdirSync(join(root, 'recipes'))
      writeFileSync(
        join(root, 'shotlist.config.json'),
        JSON.stringify({
          site: { url: `${origin}/`, settle: 200 },
          paths: { recipes: 'recipes', out: 'out' },
        }),
      )
      writeFileSync(join(root, 'recipes/home.json'), JSON.stringify({ name: 'home' }))
      const run = openRun(
        { untrusted: true, destinations: [origin] },
        join(root, 'shotlist.config.json'),
      )

      await shoot(run, run.project.library.recipes.get('home')!)
      expect(workerRequests).toBe(0)
    },
  )

  it(
    'does not let an approved WebSocket handshake redirect to another destination',
    { timeout: 120_000 },
    async () => {
      let redirected = 0
      const target = createServer((_, response) => {
        redirected++
        response.statusCode = 400
        response.end()
      })
      servers.push(target)
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
      const targetPort = (target.address() as { port: number }).port

      const redirect = createServer((_, response) => {
        response.statusCode = 302
        response.setHeader('location', `ws://127.0.0.1:${targetPort}/target`)
        response.end()
      })
      servers.push(redirect)
      await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
      const redirectPort = (redirect.address() as { port: number }).port
      const main = await listen(
        () =>
          `<main>Page</main><script>new WebSocket('ws://127.0.0.1:${redirectPort}/start')</script>`,
      )
      const root = mkdtempSync(join(tmpdir(), 'shotlist-network-browser-'))
      roots.push(root)
      mkdirSync(join(root, 'recipes'))
      writeFileSync(
        join(root, 'shotlist.config.json'),
        JSON.stringify({
          site: { url: `${main}/`, settle: 200 },
          paths: { recipes: 'recipes', out: 'out' },
        }),
      )
      writeFileSync(join(root, 'recipes/home.json'), JSON.stringify({ name: 'home' }))
      const run = openRun(
        {
          untrusted: true,
          destinations: [main, `ws://127.0.0.1:${redirectPort}`],
        },
        join(root, 'shotlist.config.json'),
      )

      await shoot(run, run.project.library.recipes.get('home')!)
      expect(redirected).toBe(0)
    },
  )

  it(
    'rejects local-file navigation from goto and openPage Steps',
    { timeout: 120_000 },
    async () => {
      const main = await listen(() => '<main>Page</main>')
      const root = mkdtempSync(join(tmpdir(), 'shotlist-network-browser-'))
      roots.push(root)
      mkdirSync(join(root, 'recipes'))
      writeFileSync(
        join(root, 'shotlist.config.json'),
        JSON.stringify({ site: { url: `${main}/` }, paths: { recipes: 'recipes', out: 'out' } }),
      )
      writeFileSync(
        join(root, 'recipes/goto.json'),
        JSON.stringify({ name: 'goto', setup: [{ goto: 'file:///tmp/private.html' }] }),
      )
      writeFileSync(
        join(root, 'recipes/open.json'),
        JSON.stringify({
          name: 'open',
          setup: [{ openPage: 'file:///tmp/private.html', as: 'private' }],
        }),
      )
      const run = openRun({ untrusted: false }, join(root, 'shotlist.config.json'))

      for (const name of ['goto', 'open']) {
        await expect(shoot(run, run.project.library.recipes.get(name)!)).rejects.toThrow(
          /Application Recipe cannot navigate to a local file/,
        )
        expect(existsSync(join(root, `out/${name}.png`))).toBe(false)
      }
    },
  )

  it(
    'lets neither optional Steps nor retries swallow a policy failure',
    { timeout: 120_000 },
    async () => {
      const blocked = await listen(() => '<p>blocked</p>')
      const main = await listen(() => '<main>Page</main>')
      const root = mkdtempSync(join(tmpdir(), 'shotlist-network-browser-'))
      roots.push(root)
      mkdirSync(join(root, 'recipes'))
      writeFileSync(
        join(root, 'shotlist.config.json'),
        JSON.stringify({ site: { url: `${main}/` }, paths: { recipes: 'recipes', out: 'out' } }),
      )
      writeFileSync(
        join(root, 'recipes/home.json'),
        JSON.stringify({
          name: 'home',
          retries: 2,
          setup: [{ optional: [{ goto: `${blocked}/private?credential=hidden` }] }],
        }),
      )
      const run = openRun(
        { untrusted: true, destinations: [main] },
        join(root, 'shotlist.config.json'),
      )
      const recipe = run.project.library.recipes.get('home')!
      let retries = 0

      await expect(shoot(run, recipe, { onRetry: () => retries++ })).rejects.toThrow(
        /Network destination/,
      )
      expect(retries).toBe(0)
      expect(existsSync(join(root, 'out/home.png'))).toBe(false)
    },
  )
})
