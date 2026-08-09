import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { ShotlistError, fromRoot } from './config.js'
import { checkCommand } from './trust.js'
import type { LoadedConfig, Serve } from './config.js'

/** A server shotlist started, and is therefore responsible for stopping. */
export interface Server {
  stop(): Promise<void>
}

/** How much of a server's output to keep, for a readiness failure to quote. */
const KEPT_LINES = 40

/**
 * Split a command line into a program and its arguments, and keep what was unquoted.
 *
 * There is no shell, so this is the whole of the parsing. The unquoted text is what
 * `refuseShellSyntax` scans: an operator only means anything outside quotes, and
 * `node -e "() => {}"` is an ordinary argument that happens to contain a `>`.
 */
function parseCommand(command: string): { tokens: string[]; bare: string } {
  const tokens: string[] = []
  let bare = ''
  let current = ''
  let quote: string | null = null
  let quoted = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      quoted = true
    } else if (/\s/.test(char)) {
      if (current || quoted) tokens.push(current)
      current = ''
      quoted = false
      bare += ' '
    } else {
      current += char
      bare += char
    }
  }
  if (quote) throw new ShotlistError(`site.serve: \`command\` has an unclosed ${quote}`)
  if (current || quoted) tokens.push(current)
  return { tokens, bare }
}

/** Split a command line into a program and its arguments, honoring quotes. */
export function tokenize(command: string): string[] {
  return parseCommand(command).tokens
}

/**
 * Refuse a command that only a shell could run, naming what to write instead.
 *
 * shotlist runs the command directly. A config file that could reach a shell would make
 * shooting somebody else's checkout a different kind of decision than it is.
 */
function refuseShellSyntax(bare: string, tokens: readonly string[]): void {
  if (!tokens.length) throw new ShotlistError('site.serve: `command` is empty')
  if (/^[A-Za-z_]\w*=/.test(tokens[0]!)) {
    throw new ShotlistError(
      `site.serve: "${tokens[0]}" sets a variable, and there is no shell to interpret it — ` +
        'put it under `env:` instead',
    )
  }
  const shellish = /&&|\|\||[|;><]|\$\(|`/.exec(bare)
  if (shellish) {
    throw new ShotlistError(
      `site.serve: \`command\` uses "${shellish[0]}", which needs a shell, and shotlist runs the ` +
        'command directly. Put it in a script of your own and run that instead.',
    )
  }
}

/** Whether an HTTP server answers at all: a 404 still proves something is listening. */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

/** Whether anything accepts a TCP connection on a port. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const settle = (answer: boolean) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(2000)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/** Whether a URL is one `fetch` can probe. */
function isHttp(url: string): boolean {
  return /^https?:\/\//.test(url)
}

/** The test that decides the server is up, from whatever `ready` was written as. */
function readinessProbe(
  ready: NonNullable<Serve['ready']> | string,
  output: readonly string[],
): () => Promise<boolean> {
  if (typeof ready === 'number') return () => accepts(ready)
  if (typeof ready === 'string') {
    if (!isHttp(ready)) {
      throw new ShotlistError(
        `site.serve: \`ready\` is "${ready}", which is neither a http(s) URL nor a port — ` +
          'give it a URL, a port number, or `{ log: <pattern> }`',
      )
    }
    return () => answers(ready)
  }
  const pattern = new RegExp(ready.log)
  return () => Promise.resolve(pattern.test(output.join('\n')))
}

/** What the server said, for an error that would otherwise be a timeout and nothing else. */
function quoted(output: readonly string[]): string {
  if (!output.length) return ', and it printed nothing'
  return `. It printed:\n${output.map((line) => `    ${line}`).join('\n')}`
}

/**
 * Start the site, unless it is already running.
 *
 * Returns null when there is nothing to stop afterwards: either the config asks for no
 * server, or one is already answering at `site.url`. That second case is the one that
 * makes `serve` worth committing — while recipes are being written the dev server is
 * usually already up in another terminal, and starting a second would only fail to bind
 * the port the first one holds.
 */
export async function startServer(loaded: LoadedConfig): Promise<Server | null> {
  const { serve, url } = loaded.config.site
  if (!serve) return null
  if (loaded.trust) checkCommand(loaded.trust, 'site.serve')
  if (isHttp(url) && (await answers(url))) return null

  const { tokens, bare } = parseCommand(serve.command)
  refuseShellSyntax(bare, tokens)
  const [program, ...args] = tokens

  const output: string[] = []
  const collect = (chunk: Buffer) => {
    output.push(...chunk.toString().split('\n'))
    if (output.length > KEPT_LINES) output.splice(0, output.length - KEPT_LINES)
  }

  const child = spawn(program!, args, {
    cwd: serve.cwd ? fromRoot(loaded, serve.cwd) : loaded.root,
    env: { ...process.env, ...serve.env },
    // Its own process group. `npm run dev` is npm, which spawns node, which is the
    // server: killing only what we spawned would leave the one holding the port.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const server = manage(child, serve.command)
  try {
    await waitUntilReady(child, serve, readinessProbe(serve.ready ?? url, output), output)
  } catch (error) {
    await server.stop()
    throw error
  }
  return server
}

/** Poll until the server is up, or it dies, or the timeout runs out — whichever is first. */
async function waitUntilReady(
  child: ChildProcess,
  serve: Serve,
  isUp: () => Promise<boolean>,
  output: readonly string[],
): Promise<void> {
  const died = new Promise<never>((_, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      const why =
        error.code === 'ENOENT'
          ? `there is no such command on PATH`
          : (error.message ?? String(error))
      reject(new ShotlistError(`site.serve: could not run \`${serve.command}\` — ${why}`))
    })
    child.once('exit', (code, signal) => {
      reject(
        new ShotlistError(
          `site.serve: \`${serve.command}\` stopped (${signal ?? `exit code ${code}`}) before it ` +
            `was ready${quoted(output)}`,
        ),
      )
    })
  })

  const deadline = Date.now() + serve.timeout
  const poll = async () => {
    for (;;) {
      if (await isUp()) return
      if (Date.now() >= deadline) {
        throw new ShotlistError(
          `site.serve: \`${serve.command}\` was not ready within ${serve.timeout}ms${quoted(output)}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // Both listeners come off as soon as the race settles: after this the server is
  // allowed to exit — that is what stopping it does — and nothing should reject then.
  try {
    await Promise.race([poll(), died])
  } finally {
    child.removeAllListeners('error')
    child.removeAllListeners('exit')
  }
}

/**
 * Own the child: signal handlers while it runs, and a group kill to stop it.
 *
 * Ctrl-C during a run would otherwise leave the server behind, holding its port, and the
 * next run would find it answering and quietly shoot against the old build.
 */
function manage(child: ChildProcess, command: string): Server {
  const group = -child.pid!

  const kill = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      // Windows has no process groups; taskkill walks the tree instead.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(group, signal)
      }
    } catch {
      // Already gone, which is the outcome this was after.
    }
  }

  const onExit = () => kill('SIGTERM')
  const onSignal = (signal: NodeJS.Signals) => {
    kill('SIGTERM')
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('exit', onExit)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let stopped: Promise<void> | null = null
  return {
    stop() {
      stopped ??= (async () => {
        process.off('exit', onExit)
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
        if (child.exitCode !== null || child.signalCode !== null) return
        const ended = once(child, 'exit')
        kill('SIGTERM')
        // A dev server that ignores SIGTERM still has to go: the next run probes the
        // port, and one that is still held reads as "already running".
        const grace = setTimeout(() => kill('SIGKILL'), 5000)
        try {
          await ended
        } catch {
          throw new ShotlistError(`site.serve: \`${command}\` could not be stopped`)
        } finally {
          clearTimeout(grace)
        }
      })()
      return stopped
    },
  }
}

/** Run `body` with the site up, stopping afterwards whatever happens. */
export async function withServer<T>(loaded: LoadedConfig, body: () => Promise<T>): Promise<T> {
  const server = await startServer(loaded)
  try {
    return await body()
  } finally {
    await server?.stop()
  }
}
