import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, run, startServer, tokenize } from '../src/index.js'
import type { LoadedConfig, Server } from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

/** A config holding just enough for `startServer`, rooted where the tests run. */
function config(site: Record<string, unknown>): LoadedConfig {
  return {
    config: parseConfig({ site: { url: 'http://127.0.0.1:0/', ...site } }),
    root: process.cwd(),
    file: 'shotlist.config.yaml',
  }
}

/** A port nothing is listening on, taken by binding one and letting it go again. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

/** Whether anything is listening, for asserting a server really did stop. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const settle = (answer: boolean) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/** Wait for a port to go quiet: a signalled process exits on its own schedule. */
async function quiet(port: number, within = 5000): Promise<boolean> {
  const deadline = Date.now() + within
  for (;;) {
    if (!(await listening(port))) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** A one-line node program that listens on a port, for a server to start and stop. */
const listener = (port: number, after = 0) =>
  `node -e "setTimeout(()=>require('http').createServer((q,s)=>s.end('ok')).listen(${port}),${after})"`

const started: Server[] = []
const stopAll = async () => {
  for (const server of started.splice(0)) await server.stop()
}
afterEach(async () => {
  await stopAll()
  removeProjects()
})

/** Start a server and remember it, so a failing assertion cannot leave one running. */
async function start(loaded: LoadedConfig): Promise<Server | null> {
  const server = await startServer(loaded)
  if (server) started.push(server)
  return server
}

describe('tokenize', () => {
  it('splits a command into a program and its arguments', () => {
    expect(tokenize('npm run dev')).toEqual(['npm', 'run', 'dev'])
    expect(tokenize('  node   server.js  ')).toEqual(['node', 'server.js'])
  })

  it('keeps a quoted argument in one piece', () => {
    expect(tokenize('node -e "one two"')).toEqual(['node', '-e', 'one two'])
    expect(tokenize("sh -c 'a b'")).toEqual(['sh', '-c', 'a b'])
  })

  it('refuses a quote that is never closed', () => {
    expect(() => tokenize('node -e "unterminated')).toThrow(/unclosed "/)
  })
})

describe('startServer', () => {
  it('starts nothing when the config asks for no server', async () => {
    expect(await start(config({}))).toBeNull()
  })

  it('uses a server that is already running rather than starting a second', async () => {
    const port = await freePort()
    const running = createServer((_, response) => response.end('ok'))
    await new Promise<void>((resolve) => running.listen(port, '127.0.0.1', resolve))
    try {
      // A command that would fail loudly if it were ever run.
      const loaded = config({ url: `http://127.0.0.1:${port}/`, serve: 'node --not-a-real-flag' })
      expect(await start(loaded)).toBeNull()
    } finally {
      await new Promise((resolve) => running.close(resolve))
    }
  })

  it('starts the site and waits until it answers', async () => {
    const port = await freePort()
    const loaded = config({ url: `http://127.0.0.1:${port}/`, serve: listener(port, 300) })
    const server = await start(loaded)
    expect(server).not.toBeNull()
    expect(await listening(port)).toBe(true)
  }, 30_000)

  it('stops the server it started, so nothing holds the port afterwards', async () => {
    const port = await freePort()
    const loaded = config({ url: `http://127.0.0.1:${port}/`, serve: listener(port) })
    const server = await start(loaded)
    await server!.stop()
    expect(await quiet(port)).toBe(true)
  }, 30_000)

  // The case the process group is for: `npm run dev` is npm, which spawns the server.
  it('stops a server that is not the process it spawned', async () => {
    const port = await freePort()
    const loaded = config({
      url: `http://127.0.0.1:${port}/`,
      serve: `node tests/nested-server.mjs ${port}`,
    })
    const server = await start(loaded)
    expect(await listening(port)).toBe(true)
    await server!.stop()
    expect(await quiet(port)).toBe(true)
  }, 30_000)

  it('waits for a port when `ready` is one', async () => {
    const port = await freePort()
    // The url is somewhere nothing answers: only `ready` can be what satisfied this.
    const loaded = config({
      url: 'http://127.0.0.1:1/',
      serve: { command: listener(port, 300), ready: port },
    })
    expect(await start(loaded)).not.toBeNull()
    expect(await listening(port)).toBe(true)
  }, 30_000)

  it('waits for a pattern in the output when `ready` is a log line', async () => {
    const loaded = config({
      url: 'http://127.0.0.1:1/',
      serve: {
        command: `node -e "setTimeout(()=>console.log('listening on 4321'),200);setTimeout(()=>{},5000)"`,
        ready: { log: 'listening on \\d+' },
      },
    })
    expect(await start(loaded)).not.toBeNull()
  }, 30_000)

  it('names the command and quotes it when the server never becomes ready', async () => {
    const loaded = config({
      url: 'http://127.0.0.1:1/',
      serve: {
        command: `node -e "console.log('booting');setTimeout(()=>{},5000)"`,
        timeout: 1000,
      },
    })
    await expect(start(loaded)).rejects.toThrow(/was not ready within 1000ms.*booting/s)
  }, 30_000)

  it('says so when the command dies before it is ready, with what it printed', async () => {
    const loaded = config({
      url: 'http://127.0.0.1:1/',
      serve: `node -e "console.error('missing dependency');process.exit(1)"`,
    })
    await expect(start(loaded)).rejects.toThrow(
      /stopped \(exit code 1\) before it was ready.*missing dependency/s,
    )
  }, 30_000)

  it('says a command that is not on PATH is not there, rather than timing out', async () => {
    const loaded = config({ url: 'http://127.0.0.1:1/', serve: 'shotlist-no-such-program' })
    await expect(start(loaded)).rejects.toThrow(
      /could not run `shotlist-no-such-program` — there is no such command on PATH/,
    )
  }, 30_000)
})

// There is no shell, so a command needing one has to be refused rather than half-run:
// `PORT=3000 npm run dev` would otherwise look for a program called `PORT=3000`.
describe('a command that only a shell could run', () => {
  const refused = async (command: string) =>
    start(config({ url: 'http://127.0.0.1:1/', serve: command }))

  it('sends an inline variable to `env:`', async () => {
    await expect(refused('PORT=3000 npm run dev')).rejects.toThrow(
      /"PORT=3000" sets a variable.*put it under `env:` instead/s,
    )
  })

  it('names the operator that would have needed a shell', async () => {
    await expect(refused('npm run build && npm run dev')).rejects.toThrow(/uses "&&"/)
    await expect(refused('npm run dev > log.txt')).rejects.toThrow(/uses ">"/)
    await expect(refused('npm run dev | tee log.txt')).rejects.toThrow(/uses "\|"/)
  })
})

// The point of all of it: a run that does not need the site to have been started for it.
describe('a run against a site shotlist starts', () => {
  it('starts it, shoots against it, and stops it again', { timeout: 120_000 }, async () => {
    const root = tempProject()
    const port = await freePort()
    const script = join(process.cwd(), 'tests/static-server.mjs')
    const fixture = join(process.cwd(), 'tests/fixture')
    const file = join(root, 'shotlist.config.yaml')
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /^ {2}url: .*$/m,
        `  url: http://127.0.0.1:${port}/\n  serve: node "${script}" ${port} "${fixture}"`,
      ),
    )

    // Without this the rewrite could silently miss, leaving the recipe pointed at the
    // fixture on disk — and every assertion below would pass having started no server.
    expect(readFileSync(file, 'utf8')).toMatch(/^ {2}serve: node /m)

    const io = { out: () => {}, err: () => {} }
    const code = await run(['order-row', '--config', file], io)

    expect(code).toBe(0)
    expect(existsSync(join(root, 'out/order-row.png'))).toBe(true)
    // Started by the run, so stopped by it: nothing is left holding the port.
    expect(await quiet(port)).toBe(true)
  })
})

describe('serve in the config', () => {
  it('refuses a `ready` that is neither a URL, a port, nor a log pattern', async () => {
    const loaded = config({ url: 'http://127.0.0.1:1/', serve: { command: 'node', ready: 'soon' } })
    await expect(start(loaded)).rejects.toThrow(/`ready` is "soon", which is neither/)
  })
})
