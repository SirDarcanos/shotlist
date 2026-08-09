import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  Recipe,
  envFor,
  interpolate,
  loadConfig,
  loadLibrary,
  parseConfig,
  readSession,
  sessionFor,
  shoot,
  signIn,
  trustFrom,
} from '../src/index.js'
import type { LoadedConfig } from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = 'https://example.com/'

/** Serve the fixture directory, because a `file:` origin keeps no cookies. */
let server: Server
let origin: string

beforeAll(
  () =>
    new Promise<void>((ready) => {
      server = createServer((request, response) => {
        const { pathname } = new URL(request.url ?? '/', 'http://localhost')
        try {
          response.end(readFileSync(join(HERE, 'fixture', pathname.replace(/^\/+/, ''))))
        } catch {
          response.statusCode = 404
          response.end('not found')
        }
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
        ready()
      })
    }),
)

afterAll(async () => {
  removeProjects()
  await new Promise((done) => server.close(done))
})

const KEPT = { ...process.env }
afterEach(() => {
  process.env = { ...KEPT }
})

/** A throwaway project pointed at the served sign-in page, with a session and a macro. */
function project(options: { verify?: string; allowEnv?: string[] } = {}): {
  loaded: LoadedConfig
  library: ReturnType<typeof loadLibrary>
  root: string
} {
  const root = tempProject()
  // The copied recipes lean on `finders` this config drops; these write their own.
  rmSync(join(root, 'recipes'), { recursive: true, force: true })
  rmSync(join(root, 'macros'), { recursive: true, force: true })
  mkdirSync(join(root, 'recipes'), { recursive: true })
  writeFileSync(
    join(root, 'shotlist.config.yaml'),
    `site:
  url: ${origin}/signin.html
  viewport: { width: 800, height: 600 }
  scale: 1
  # Short, because two of these tests wait this out on purpose.
  timeout: 2000
  sessions:
    admin:
      path: .shotlist/admin.json
${options.verify === undefined ? '' : `      verify: '${options.verify}'\n`}paths:
  recipes: recipes
  macros: macros
  data: data
  out: out
`,
  )
  mkdirSync(join(root, 'macros'), { recursive: true })
  writeFileSync(
    join(root, 'macros', 'sign-in.yaml'),
    `steps:
  - fill: { css: '#username' }
    value: '\${env.FIXTURE_USER}'
  - fill: { css: '#password' }
    value: '\${env.FIXTURE_PASSWORD}'
  - click: { css: '#signin' }
`,
  )
  const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
  loaded.trust = trustFrom(
    { root, siteUrl: loaded.config.site.url, granted: { env: options.allowEnv ?? [] } },
    false,
  )
  const { paths, finders } = loaded.config
  const library = loadLibrary({
    recipes: join(root, paths.recipes),
    macros: join(root, paths.macros),
    data: join(root, paths.data),
    finders,
  })
  return { loaded, library, root }
}

describe('site.sessions', () => {
  it('takes a bare path as shorthand for one with no verify selector', () => {
    const config = parseConfig({
      site: { url: SITE, sessions: { admin: '.shotlist/admin.json' } },
    })
    expect(config.site.sessions['admin']).toEqual({ path: '.shotlist/admin.json' })
  })

  it('takes the mapping, with the selector that proves a session still works', () => {
    const config = parseConfig({
      site: { url: SITE, sessions: { admin: { path: 'a.json', verify: '#account' } } },
    })
    expect(config.site.sessions['admin']).toEqual({ path: 'a.json', verify: '#account' })
  })

  it('is empty rather than absent, so nothing has to check for the key', () => {
    expect(parseConfig({ site: { url: SITE } }).site.sessions).toEqual({})
  })

  it('refuses a key the schema does not know, rather than ignoring it', () => {
    expect(() =>
      parseConfig({ site: { url: SITE, sessions: { admin: { path: 'a.json', user: 'me' } } } }),
    ).toThrow()
  })
})

describe('a recipe naming a session', () => {
  it('carries the name through', () => {
    expect(Recipe.parse({ name: 'dash', session: 'admin' }).session).toBe('admin')
  })

  it('says which sessions there are when it names one that is not declared', () => {
    const { loaded } = project()
    expect(() => sessionFor(loaded, 'editor', 'recipe "dash"')).toThrow(/no session named "editor"/)
    expect(() => sessionFor(loaded, 'editor', 'recipe "dash"')).toThrow(/"admin"/)
  })

  it('resolves the file from the config, not the working directory', () => {
    const { loaded, root } = project()
    expect(sessionFor(loaded, 'admin', 'x').file).toBe(join(root, '.shotlist/admin.json'))
  })
})

describe('a session that is not there yet', () => {
  it('names the command that writes it, rather than reporting a missing file', () => {
    const { loaded } = project()
    expect(() => readSession(sessionFor(loaded, 'admin', 'x'))).toThrow(/shotlist --login admin/)
  })

  it('says the same when the file is there but is not a session', () => {
    const { loaded, root } = project()
    mkdirSync(join(root, '.shotlist'), { recursive: true })
    writeFileSync(join(root, '.shotlist/admin.json'), 'not json')
    expect(() => readSession(sessionFor(loaded, 'admin', 'x'))).toThrow(/--login admin/)
  })
})

describe('${env.NAME}', () => {
  const withEnv = (allowed: string[]) =>
    trustFrom({ root: '/p', siteUrl: SITE, granted: { env: allowed } }, false)

  it('resolves a variable the operator allowed', () => {
    process.env['FIXTURE_PASSWORD'] = 'hunter2'
    const vars = { env: envFor(withEnv(['FIXTURE_PASSWORD'])) }
    expect(interpolate('${env.FIXTURE_PASSWORD}', vars)).toBe('hunter2')
  })

  it('does not resolve one the operator did not allow, whatever is set', () => {
    process.env['FIXTURE_PASSWORD'] = 'hunter2'
    const vars = { env: envFor(withEnv(['SOMETHING_ELSE'])) }
    expect(() => interpolate('${env.FIXTURE_PASSWORD}', vars)).toThrow(
      /--allow-env FIXTURE_PASSWORD/,
    )
  })

  it('leaves an allowed name that is empty unresolved, rather than filling in nothing', () => {
    process.env['FIXTURE_PASSWORD'] = ''
    const vars = { env: envFor(withEnv(['FIXTURE_PASSWORD'])) }
    expect(() => interpolate('${env.FIXTURE_PASSWORD}', vars)).toThrow(/is not set/)
  })

  it('throws inside a longer string too, where leaving it would type the reference', () => {
    const vars = { env: envFor(withEnv([])) }
    expect(() => interpolate('Bearer ${env.TOKEN}', vars)).toThrow(/--allow-env TOKEN/)
  })

  it('is left alone while a macro is being expanded, for the frame below to fill', () => {
    expect(interpolate('${env.TOKEN}', {}, 'keep')).toBe('${env.TOKEN}')
  })

  it('reads SHOTLIST_ENV as well as the flag', () => {
    process.env['SHOTLIST_ENV'] = 'FROM_ENV, ALSO_THIS'
    process.env['FROM_ENV'] = 'yes'
    const trust = trustFrom({ root: '/p', siteUrl: SITE, granted: { env: ['FROM_FLAG'] } }, false)
    expect(trust.env).toEqual(['FROM_FLAG', 'FROM_ENV', 'ALSO_THIS'])
    expect(envFor(trust)).toEqual({ FROM_ENV: 'yes' })
  })
})

describe('allowEnv in the config', () => {
  it('grants the same names the flag does, so a run needs no flag at all', () => {
    process.env['FIXTURE_PASSWORD'] = 'hunter2'
    const trust = trustFrom({ root: '/p', siteUrl: SITE, allowEnv: ['FIXTURE_PASSWORD'] }, false)
    expect(envFor(trust)).toEqual({ FIXTURE_PASSWORD: 'hunter2' })
  })

  it('adds to the flag rather than replacing it', () => {
    process.env['FROM_CONFIG'] = 'a'
    process.env['FROM_FLAG'] = 'b'
    const trust = trustFrom(
      { root: '/p', siteUrl: SITE, allowEnv: ['FROM_CONFIG'], granted: { env: ['FROM_FLAG'] } },
      false,
    )
    expect(envFor(trust)).toEqual({ FROM_CONFIG: 'a', FROM_FLAG: 'b' })
  })

  it('is a list of names — a mapping of values is refused, not committed', () => {
    expect(() => parseConfig({ site: { url: SITE }, allowEnv: { A: 'secret' } })).toThrow(
      /list of variable names/,
    )
  })
})

describe('an untrusted run', () => {
  it('reads no variable, however it was allowed — flag, environment or config', () => {
    process.env['SHOTLIST_ENV'] = 'FROM_ENV'
    process.env['FROM_ENV'] = 'yes'
    process.env['FROM_CONFIG'] = 'yes'
    const trust = trustFrom(
      {
        root: '/p',
        siteUrl: SITE,
        allowEnv: ['FROM_CONFIG'],
        granted: { env: ['FROM_FLAG'] },
      },
      true,
    )
    expect(trust.env).toEqual([])
    expect(envFor(trust)).toEqual({})
  })

  it('loads no session, because the browser carrying one is signed in as somebody', () => {
    const { loaded, root } = project()
    loaded.trust = trustFrom({ root, siteUrl: loaded.config.site.url }, true)
    expect(() => sessionFor(loaded, 'admin', 'recipe "dash"')).toThrow(/does not load sessions/)
  })
})

describe('--login', () => {
  it(
    'signs in with a macro, and writes a session that a later shot is signed in by',
    { timeout: 120_000 },
    async () => {
      process.env['FIXTURE_USER'] = 'Ada'
      process.env['FIXTURE_PASSWORD'] = 'hunter2'
      const { loaded, library, root } = project({
        verify: '#account',
        allowEnv: ['FIXTURE_USER', 'FIXTURE_PASSWORD'],
      })
      const said: string[] = []
      await signIn(loaded, library, sessionFor(loaded, 'admin', '--login'), {
        using: 'sign-in',
        say: (line) => said.push(line),
      })

      const file = join(root, '.shotlist/admin.json')
      expect(existsSync(file)).toBe(true)
      expect(said.join('\n')).toContain(file)
      // The cookie is what the next run is signed in by, so it has to be in there.
      expect(JSON.stringify(readSession(sessionFor(loaded, 'admin', 'x')))).toContain(
        'fixture-session',
      )

      writeFileSync(
        join(root, 'recipes', 'dash.yaml'),
        `name: dash\nsession: admin\nclip: { css: '#account' }\n`,
      )
      const reloaded = loadLibrary({
        recipes: join(root, 'recipes'),
        macros: join(root, 'macros'),
        data: join(root, 'data'),
        finders: {},
      })
      const result = await shoot(reloaded.recipes.get('dash')!, reloaded, loaded)
      expect(existsSync(result.file)).toBe(true)
    },
  )

  it('refuses to sign in by hand where there is no terminal to wait in', async () => {
    const { loaded, library } = project()
    await expect(
      signIn(loaded, library, sessionFor(loaded, 'admin', '--login'), { say: () => {} }),
    ).rejects.toThrow(/--using <macro>/)
  })

  it(
    'writes nothing when the sign-in did not take, rather than a session of the form',
    { timeout: 120_000 },
    async () => {
      process.env['FIXTURE_USER'] = 'Ada'
      // No password, so the fixture refuses and `#account` never appears.
      process.env['FIXTURE_PASSWORD'] = 'x'
      const { loaded, library, root } = project({
        verify: '#nothing-with-this-id',
        allowEnv: ['FIXTURE_USER', 'FIXTURE_PASSWORD'],
      })
      await expect(
        signIn(loaded, library, sessionFor(loaded, 'admin', '--login'), {
          using: 'sign-in',
          say: () => {},
        }),
      ).rejects.toThrow(/does not look signed in. Nothing was written/)
      expect(existsSync(join(root, '.shotlist/admin.json'))).toBe(false)
    },
  )

  it(
    'reports an expired session instead of shooting the sign-in page',
    { timeout: 120_000 },
    async () => {
      const { loaded, root } = project({ verify: '#account' })
      // A session shaped right and signed in as nobody, which is what an expired one is.
      mkdirSync(join(root, '.shotlist'), { recursive: true })
      writeFileSync(
        join(root, '.shotlist/admin.json'),
        JSON.stringify({ cookies: [], origins: [] }),
      )
      writeFileSync(
        join(root, 'recipes', 'dash.yaml'),
        `name: dash\nsession: admin\nclip: viewport\n`,
      )
      const library = loadLibrary({
        recipes: join(root, 'recipes'),
        macros: join(root, 'macros'),
        data: join(root, 'data'),
        finders: {},
      })
      await expect(shoot(library.recipes.get('dash')!, library, loaded)).rejects.toThrow(
        /most likely expired/,
      )
    },
  )
})
