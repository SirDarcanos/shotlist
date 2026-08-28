import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { answers } from '../src/network-node.js'
import type { NodeNetworkAdapter } from '../src/network-node.js'
import { compileNetworkPolicy } from '../src/network-policy.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
})

/** Start an HTTP server and return its exact Network destination. */
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return `http://127.0.0.1:${port}`
}

describe('Node readiness Network enforcement', () => {
  it('checks every scripted redirect before the fake adapter sends it', async () => {
    const sent: string[] = []
    const adapter: NodeNetworkAdapter = {
      request(url) {
        sent.push(url)
        return Promise.resolve(
          url === 'https://allowed.example/start'
            ? { status: 302, location: 'https://blocked.example/next?secret=value' }
            : { status: 200 },
        )
      },
      connect: () => Promise.resolve(true),
    }
    const access = compileNetworkPolicy({
      operator: ['allowed.example'],
      project: [],
      untrusted: true,
      deny: [],
    }).forOperation('readiness')

    await expect(answers(access, 'https://allowed.example/start', adapter)).rejects.toThrow(
      /https:\/\/blocked\.example/,
    )
    expect(sent).toEqual(['https://allowed.example/start'])
  })

  it('authorizes a redirect target before following it', async () => {
    let reached = false
    const blocked = await serve((_, response) => {
      reached = true
      response.end('ok')
    })
    const initial = await serve((_, response) => {
      response.statusCode = 302
      response.setHeader('location', `${blocked}/ready?token=secret`)
      response.end()
    })
    const access = compileNetworkPolicy({
      operator: [initial],
      project: [],
      untrusted: true,
      deny: [],
    }).forOperation('readiness')

    await expect(answers(access, `${initial}/start`)).rejects.toThrow(
      new RegExp(`Network destination http:\\/\\/127\\.0\\.0\\.1:${new URL(blocked).port}`),
    )
    expect(reached).toBe(false)
  })
})
