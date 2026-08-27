import { createServer } from 'node:http'
import type { Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  Recipe,
  interpolate,
  narrowSession,
  openRun,
  parseConfig,
  readSession,
  sessionFor,
  sessionHosts,
  shoot,
  signIn,
} from '../src/index.js'
import type { OperatorAuthority, Run, StorageState } from '../src/index.js'
import { envFor, trustFrom } from '../src/trust.js'
import { removeProjects, tempProject } from './tempProject.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = 'https://example.com/'

/**
 * Serve the fixture directory, because a `file:` origin keeps no cookies.
 *
 * Two of these run under names that are genuinely different hosts, so a sign-in can pass
 * through one and leave its cookies behind — which is what a round trip through an
 * identity provider does, and a port would not reproduce: a cookie jar is keyed on the
 * host and ignores the port entirely.
 */
function serve(host: string): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((ready) => {
    const server: Server = createServer((request, response) => {
      const requested = new URL(request.url ?? '/', 'http://localhost')
      const { pathname } = requested
      if (pathname === '/bounce.html') {
        response.end(
          `<script>location.href=${JSON.stringify(requested.searchParams.get('to'))}</script>`,
        )
        return
      }
      try {
        response.end(readFileSync(join(HERE, 'fixture', pathname.replace(/^\/+/, ''))))
      } catch {
        response.statusCode = 404
        response.end('not found')
      }
    })
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      ready({
        origin: `http://${host}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

let site: Awaited<ReturnType<typeof serve>>
let provider: Awaited<ReturnType<typeof serve>>
let origin: string

beforeAll(async () => {
  ;[site, provider] = await Promise.all([serve('127.0.0.1'), serve('localhost')])
  origin = site.origin
})

afterAll(async () => {
  removeProjects()
  await Promise.all([site?.close(), provider?.close()])
})

const KEPT = { ...process.env }
afterEach(() => {
  process.env = { ...KEPT }
})

/** A throwaway project pointed at the served sign-in page, with a session and a macro. */
function project(
  options: {
    verify?: string
    allowEnv?: string[]
    keep?: string[]
    siteUrl?: string
    sessionPath?: string
  } = {},
  authority: OperatorAuthority = { untrusted: false, env: options.allowEnv ?? [] },
) {
  const root = tempProject()
  // The copied recipes lean on `finders` this config drops; these write their own.
  rmSync(join(root, 'recipes'), { recursive: true, force: true })
  rmSync(join(root, 'macros'), { recursive: true, force: true })
  mkdirSync(join(root, 'recipes'), { recursive: true })
  writeFileSync(
    join(root, 'shotlist.config.yaml'),
    `site:
  url: ${options.siteUrl ?? `${origin}/signin.html`}
  viewport: { width: 800, height: 600 }
  scale: 1
  # Short, because two of these tests wait this out on purpose.
  timeout: 2000
  sessions:
    admin:
      path: ${options.sessionPath ?? '.shotlist/admin.json'}
${options.verify === undefined ? '' : `      verify: '${options.verify}'\n`}${
      options.keep === undefined ? '' : `      keep: [${options.keep.join(', ')}]\n`
    }paths:
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
  const run = openRun(authority, join(root, 'shotlist.config.yaml'))
  return { run, loaded: run.project, library: run.project.library, root }
}

/** Open the temporary Project as an immutable Run. */
function projectRun(
  options: Parameters<typeof project>[0] = {},
  authority: OperatorAuthority = { untrusted: false },
): ReturnType<typeof project> & { run: Run } {
  return project(options, authority)
}

describe('site.sessions', () => {
  it('takes a bare path as shorthand for one with no verify selector', () => {
    const config = parseConfig({
      site: { url: SITE, sessions: { admin: '.shotlist/admin.json' } },
    })
    expect(config.site.sessions['admin']).toEqual({ path: '.shotlist/admin.json', keep: [] })
  })

  it('takes the mapping, with the selector that proves a session still works', () => {
    const config = parseConfig({
      site: { url: SITE, sessions: { admin: { path: 'a.json', verify: '#account' } } },
    })
    expect(config.site.sessions['admin']).toEqual({ path: 'a.json', verify: '#account', keep: [] })
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
    const { run } = project()
    expect(() => sessionFor(run, 'editor', 'recipe "dash"')).toThrow(/no session named "editor"/)
    expect(() => sessionFor(run, 'editor', 'recipe "dash"')).toThrow(/"admin"/)
  })

  it('resolves the file from the config, not the working directory', () => {
    const { run, root } = project()
    expect(sessionFor(run, 'admin', 'x').file).toBe(
      join(realpathSync(root), '.shotlist/admin.json'),
    )
  })

  it('resolves a Session through the Run', () => {
    const { run, root } = projectRun({ verify: '#account', keep: ['accounts.example.test'] })

    expect(sessionFor(run, 'admin', 'recipe "dash"')).toEqual({
      name: 'admin',
      file: join(realpathSync(root), '.shotlist/admin.json'),
      verify: '#account',
      keep: ['accounts.example.test'],
    })
  })

  it('authorizes a dangling Session symlink to a missing root-level target', () => {
    const made = project()
    const denied = `shotlist-denied-${basename(made.root)}`
    mkdirSync(join(made.root, '.shotlist'), { recursive: true })
    symlinkSync(`/${denied}/admin.json`, join(made.root, '.shotlist/admin.json'))
    const run = openRun(
      { untrusted: false, deny: [denied] },
      join(made.root, 'shotlist.config.yaml'),
    )

    expect(() => sessionFor(run, 'admin', 'recipe "dash"')).toThrow(
      new RegExp(`${denied}.*forbidden path`, 's'),
    )
  })

  it('refuses an untrusted Run before observing its Session path', () => {
    const { run } = projectRun({}, { untrusted: true })

    expect(() => sessionFor(run, 'admin', 'recipe "dash"')).toThrow(/does not load sessions/)
  })
})

describe('a session that is not there yet', () => {
  it('names the command through the Run that writes it', () => {
    const { run } = projectRun()

    expect(() => readSession(run, sessionFor(run, 'admin', 'x'))).toThrow(/shotlist --login admin/)
  })

  it('uses configured keep hosts rather than a fabricated Session value', () => {
    const { run } = projectRun()
    const fabricated = {
      name: 'admin',
      file: 'elsewhere.json',
      keep: ['accounts.example.test'],
    }

    expect(sessionHosts(run, fabricated)).not.toContain('accounts.example.test')
  })

  it('reauthorizes a public Session before reading its file', () => {
    const { run, root } = projectRun(
      { sessionPath: 'credential-vault/admin.json' },
      { untrusted: false, deny: ['credential-vault'] },
    )
    const fabricated = { name: 'admin', file: join(root, 'elsewhere.json'), keep: [] }

    expect(() => readSession(run, fabricated)).toThrow(/credential-vault.*forbidden path/s)
  })

  it('names the command that writes it, rather than reporting a missing file', () => {
    const { run } = project()
    expect(() => readSession(run, sessionFor(run, 'admin', 'x'))).toThrow(/shotlist --login admin/)
  })

  it('says the same when the file is there but is not a session', () => {
    const { run, root } = project()
    mkdirSync(join(root, '.shotlist'), { recursive: true })
    writeFileSync(join(root, '.shotlist/admin.json'), 'not json')
    expect(() => readSession(run, sessionFor(run, 'admin', 'x'))).toThrow(/--login admin/)
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

describe('SHOTLIST_ENV_DENY', () => {
  it('takes a name back out, whatever the config or the flag allowed', () => {
    process.env['SHOTLIST_ENV_DENY'] = 'ADMIN_PASSWORD'
    process.env['ADMIN_PASSWORD'] = 'hunter2'
    const trust = trustFrom(
      {
        root: '/p',
        siteUrl: SITE,
        allowEnv: ['ADMIN_PASSWORD'],
        granted: { env: ['ADMIN_PASSWORD'] },
      },
      false,
    )
    expect(trust.env).toEqual([])
    expect(envFor(trust)).toEqual({})
  })

  it('globs, the way the path list does', () => {
    process.env['SHOTLIST_ENV_DENY'] = 'AWS_*, *_TOKEN'
    process.env['AWS_SECRET_KEY'] = 'a'
    process.env['NPM_TOKEN'] = 'b'
    process.env['SAFE_ONE'] = 'c'
    const trust = trustFrom(
      { root: '/p', siteUrl: SITE, allowEnv: ['AWS_SECRET_KEY', 'NPM_TOKEN', 'SAFE_ONE'] },
      false,
    )
    expect(envFor(trust)).toEqual({ SAFE_ONE: 'c' })
  })

  it('leaves everything alone when it is not set', () => {
    process.env['ADMIN_PASSWORD'] = 'hunter2'
    const trust = trustFrom({ root: '/p', siteUrl: SITE, allowEnv: ['ADMIN_PASSWORD'] }, false)
    expect(envFor(trust)).toEqual({ ADMIN_PASSWORD: 'hunter2' })
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
    const { run } = project({}, { untrusted: true })
    expect(() => sessionFor(run, 'admin', 'recipe "dash"')).toThrow(/does not load sessions/)
  })
})

describe('what a session keeps', () => {
  const SITE_HOSTS = ['app.example.com']

  /** A state shaped the way Playwright writes one. */
  const state = (cookies: Array<{ domain: string }>, origins: Array<{ origin: string }> = []) => ({
    cookies: cookies.map((one) => ({ name: 'sid', value: 'x', path: '/', ...one })),
    origins: origins.map((one) => ({ localStorage: [{ name: 'token', value: 'x' }], ...one })),
  })

  const domainsIn = (result: ReturnType<typeof narrowSession>) =>
    result.state.cookies.map((one) => one.domain)

  it('drops the provider session an OAuth round trip swept up', () => {
    const result = narrowSession(
      state([
        { domain: 'app.example.com' },
        { domain: '.google.com' },
        { domain: 'accounts.google.com' },
        { domain: '.youtube.com' },
      ]),
      SITE_HOSTS,
    )
    expect(domainsIn(result)).toEqual(['app.example.com'])
    expect(result.dropped.cookies).toBe(3)
    expect(result.dropped.hosts).toEqual(['google.com', 'accounts.google.com', 'youtube.com'])
  })

  it('keeps a cookie set on the apex, which is where a session cookie usually is', () => {
    // The site is `app.example.com` and the cookie is `.example.com`: dropping it is
    // dropping the sign-in itself, which is the way this narrowing breaks a project.
    expect(domainsIn(narrowSession(state([{ domain: '.example.com' }]), SITE_HOSTS))).toEqual([
      '.example.com',
    ])
  })

  it('keeps a cookie on a host under the site, because the run may open one', () => {
    expect(
      domainsIn(narrowSession(state([{ domain: 'api.example.com' }]), ['example.com'])),
    ).toEqual(['api.example.com'])
  })

  it('drops a host that only ends the same way', () => {
    // The two that a bare `endsWith` in either direction lets through: a name whose last
    // label boundary falls in the middle of the site's, and a longer name it prefixes.
    const result = narrowSession(
      state([
        { domain: 'evil-app.example.com' },
        { domain: 'app.example.com.evil.test' },
        { domain: 'notexample.com' },
      ]),
      SITE_HOSTS,
    )
    expect(domainsIn(result)).toEqual([])
    expect(result.dropped.cookies).toBe(3)
    expect(
      domainsIn(narrowSession(state([{ domain: 'notexample.com' }]), ['example.com'])),
    ).toEqual([])
  })

  it('keeps a host the config named in site.allow', () => {
    const hosts = ['app.example.com', 'auth.partner.test']
    expect(domainsIn(narrowSession(state([{ domain: 'auth.partner.test' }]), hosts))).toEqual([
      'auth.partner.test',
    ])
  })

  it('keeps local storage for the site and its subdomains, and no other origin', () => {
    const result = narrowSession(
      state(
        [],
        [
          { origin: 'https://app.example.com' },
          { origin: 'https://inner.app.example.com' },
          { origin: 'https://accounts.google.com' },
          { origin: 'not a url' },
        ],
      ),
      SITE_HOSTS,
    )
    expect(result.state.origins.map((one) => one.origin)).toEqual([
      'https://app.example.com',
      'https://inner.app.example.com',
    ])
    expect(result.dropped.origins).toBe(2)
  })

  it('does not share local storage up the domain tree the way a cookie is shared', () => {
    // `.example.com` is a cookie `app.example.com` is sent; `https://example.com` is an
    // origin it cannot read. The two rules differ on purpose.
    const both = narrowSession(
      state([{ domain: '.example.com' }], [{ origin: 'https://example.com' }]),
      SITE_HOSTS,
    )
    expect(both.state.cookies).toHaveLength(1)
    expect(both.state.origins).toHaveLength(0)
  })

  it('reads a file that is not a state at all as holding nothing', () => {
    expect(narrowSession('nonsense', SITE_HOSTS).state).toEqual({ cookies: [], origins: [] })
    expect(narrowSession(null, SITE_HOSTS).state).toEqual({ cookies: [], origins: [] })
  })

  it('reads and narrows a Session through the Run', () => {
    const { run, root } = projectRun()
    mkdirSync(join(root, '.shotlist'), { recursive: true })
    writeFileSync(
      join(root, '.shotlist/admin.json'),
      JSON.stringify(state([{ domain: '127.0.0.1' }, { domain: '.google.com' }])),
    )

    const read = readSession(run, sessionFor(run, 'admin', 'x'))
    expect(read.cookies.map((one) => one.domain)).toEqual(['127.0.0.1'])
  })

  it('narrows a file written before it did, when that file is loaded', () => {
    const { run, root } = project()
    mkdirSync(join(root, '.shotlist'), { recursive: true })
    writeFileSync(
      join(root, '.shotlist/admin.json'),
      JSON.stringify(state([{ domain: '127.0.0.1' }, { domain: '.google.com' }])),
    )
    const read = readSession(run, sessionFor(run, 'admin', 'x'))
    expect(read.cookies.map((one) => one.domain)).toEqual(['127.0.0.1'])
  })
})

describe('--login', () => {
  /** The fixture's sign-in, filled in at whichever origin it is pointed at. */
  const signInAt = (at: string, who: string, from = origin) => {
    const destination = `${at}/signin.html`
    const entry =
      at === from ? destination : `${from}/bounce.html?to=${encodeURIComponent(destination)}`
    return `  - goto: ${entry}
  - fill: { css: '#username' }
    value: ${who}
  - fill: { css: '#password' }
    value: hunter2
  - click: { css: '#signin' }
`
  }

  /** A Project whose sign-in macro is on disk before the Run opens. */
  function withSignIn(options: Parameters<typeof project>[0], steps: string) {
    const made = project(options)
    writeFileSync(join(made.root, 'macros', 'via-provider.yaml'), `steps:\n${steps}`)
    const run = openRun({ untrusted: false }, join(made.root, 'shotlist.config.yaml'))
    return { ...made, run, loaded: run.project, library: run.project.library }
  }

  /** Run `--login admin` with that macro, collecting what it said. */
  async function login(made: ReturnType<typeof withSignIn>) {
    const said: string[] = []
    await signIn(made.run, 'admin', {
      using: 'via-provider',
      say: (line) => said.push(line),
    })
    return said.join('\n')
  }

  /** What ended up on disk. */
  const written = (root: string) =>
    JSON.parse(readFileSync(join(root, '.shotlist/admin.json'), 'utf8')) as StorageState

  it('uses the Run environment snapshot for a scripted login', { timeout: 120_000 }, async () => {
    process.env['FIXTURE_USER'] = 'Ada'
    process.env['FIXTURE_PASSWORD'] = 'hunter2'
    const made = projectRun(
      { verify: '#account' },
      { untrusted: false, env: ['FIXTURE_USER', 'FIXTURE_PASSWORD'] },
    )
    process.env['FIXTURE_USER'] = 'Mallory'
    process.env['FIXTURE_PASSWORD'] = 'wrong'

    const said: string[] = []
    await signIn(made.run, 'admin', {
      using: 'sign-in',
      say: (line) => said.push(line),
    })

    expect(JSON.stringify(written(made.root))).toContain('Ada')
    expect(said[0]).toMatch(/FIXTURE_USER, FIXTURE_PASSWORD/)
    if (process.platform !== 'win32') {
      expect(statSync(join(made.root, '.shotlist/admin.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('loads a Session through Run-based capture', { timeout: 120_000 }, async () => {
    process.env['FIXTURE_USER'] = 'Ada'
    process.env['FIXTURE_PASSWORD'] = 'hunter2'
    const made = project({ verify: '#account' })
    writeFileSync(
      join(made.root, 'recipes/dash.yaml'),
      `name: dash\nsession: admin\nclip: { css: '#account' }\n`,
    )
    const run = openRun(
      { untrusted: false, env: ['FIXTURE_USER', 'FIXTURE_PASSWORD'] },
      join(made.root, 'shotlist.config.yaml'),
    )
    await signIn(run, 'admin', { using: 'sign-in', say: () => {} })

    const recipe = run.project.library.recipes.get('dash')!
    const result = await shoot(run, recipe)

    expect(existsSync(result.file)).toBe(true)
  })

  it('refuses an untrusted Session capture before browser or output effects', async () => {
    const made = project({ siteUrl: 'https://example.com/' })
    writeFileSync(
      join(made.root, 'recipes/dash.yaml'),
      `name: dash\nsession: admin\nclip: viewport\n`,
    )
    const run = openRun({ untrusted: true }, join(made.root, 'shotlist.config.yaml'))

    await expect(shoot(run, run.project.library.recipes.get('dash')!)).rejects.toThrow(
      /does not load sessions/,
    )
    expect(existsSync(join(made.root, 'out/dash.png'))).toBe(false)
  })

  it(
    'keeps the expired-Session diagnostic Recipe-addressed through the Run',
    { timeout: 120_000 },
    async () => {
      const made = project({ verify: '#account' })
      mkdirSync(join(made.root, '.shotlist'), { recursive: true })
      writeFileSync(
        join(made.root, '.shotlist/admin.json'),
        JSON.stringify({ cookies: [], origins: [] }),
      )
      writeFileSync(
        join(made.root, 'recipes/dash.yaml'),
        `name: dash\nsession: admin\nclip: viewport\n`,
      )
      const run = openRun({ untrusted: false }, join(made.root, 'shotlist.config.yaml'))

      await expect(shoot(run, run.project.library.recipes.get('dash')!)).rejects.toThrow(
        /recipe "dash": `session`.*most likely expired/s,
      )
    },
  )

  it('creates no Session directory when manual Run login cannot wait', async () => {
    const made = projectRun()

    await expect(signIn(made.run, 'admin', { say: () => {} })).rejects.toThrow(/--using <macro>/)
    expect(existsSync(join(made.root, '.shotlist'))).toBe(false)
  })

  it(
    'refuses a dangling Session symlink whose future target is denied',
    { timeout: 120_000 },
    async () => {
      process.env['FIXTURE_USER'] = 'Ada'
      process.env['FIXTURE_PASSWORD'] = 'hunter2'
      const made = project({ verify: '#account' })
      const target = join(made.root, 'credential-vault/admin.json')
      const link = join(made.root, '.shotlist/admin.json')
      mkdirSync(dirname(target), { recursive: true })
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(target, link)
      const run = openRun(
        {
          untrusted: false,
          deny: ['credential-vault'],
          env: ['FIXTURE_USER', 'FIXTURE_PASSWORD'],
        },
        join(made.root, 'shotlist.config.yaml'),
      )

      await expect(signIn(run, 'admin', { using: 'sign-in', say: () => {} })).rejects.toThrow(
        /credential-vault.*forbidden path/s,
      )
      expect(existsSync(target)).toBe(false)
    },
  )

  it('refuses an untrusted Run before launching or creating a directory', async () => {
    const made = projectRun({}, { untrusted: true })

    await expect(signIn(made.run, 'admin', { say: () => {} })).rejects.toThrow(
      /does not load sessions/,
    )
    expect(existsSync(join(made.root, '.shotlist'))).toBe(false)
  })

  it(
    'writes none of what a round trip through another host left in the browser',
    { timeout: 120_000 },
    async () => {
      const made = withSignIn(
        { verify: '#account' },
        signInAt(provider.origin, 'Provider') + signInAt(origin, 'Ada'),
      )
      const said = await login(made)

      const file = written(made.root)
      expect(file.cookies.map((one) => one.domain)).toEqual(['127.0.0.1'])
      // Signed in as Ada rather than as Provider: the site's own cookie survived.
      expect(JSON.stringify(file)).toContain('Ada')
      expect(said).toMatch(/left out 1 cookie for localhost/)
    },
  )

  it(
    'refuses to write a session that signing in produced and narrowing broke',
    { timeout: 120_000 },
    async () => {
      // The site is one host and the sign-in leaves its cookie on another, so the browser
      // is signed in and what would be saved is not. Without the second check this writes
      // a file that looks fine and turns every shot of the next run into the sign-in form.
      const made = withSignIn(
        { verify: '#account', siteUrl: `${provider.origin}/signin.html` },
        signInAt(origin, 'Ada', provider.origin),
      )
      await expect(login(made)).rejects.toThrow(/site\.sessions\.admin\.keep/)
      await expect(login(made)).rejects.toThrow(/Nothing was written/)
      expect(existsSync(join(made.root, '.shotlist/admin.json'))).toBe(false)
    },
  )

  it('retains keep warnings through Run login', { timeout: 120_000 }, async () => {
    const made = withSignIn(
      { verify: '#account', keep: ['localhost'] },
      signInAt(provider.origin, 'Provider') + signInAt(origin, 'Ada'),
    )
    const run = openRun(
      { untrusted: false, hosts: ['localhost'] },
      join(made.root, 'shotlist.config.yaml'),
    )
    const said: string[] = []

    await signIn(run, 'admin', {
      using: 'via-provider',
      say: (line) => said.push(line),
    })

    expect(
      written(made.root)
        .cookies.map((one) => one.domain)
        .sort(),
    ).toEqual(['127.0.0.1', 'localhost'])
    expect(said.join('\n')).toMatch(/site\.sessions\.admin\.keep.*signs in as/s)
  })

  it(
    'keeps another host when the session says to, and says whose account that is',
    { timeout: 120_000 },
    async () => {
      const made = withSignIn(
        { verify: '#account', keep: ['localhost'] },
        signInAt(provider.origin, 'Provider') + signInAt(origin, 'Ada'),
      )
      const said = await login(made)

      const domains = written(made.root)
        .cookies.map((one) => one.domain)
        .sort()
      expect(domains).toEqual(['127.0.0.1', 'localhost'])
      expect(said).toMatch(/`site\.sessions\.admin\.keep` names localhost/)
      expect(said).toMatch(/signs in as whoever those hosts know you as/)
    },
  )

  it(
    'names the host and the variables before a scripted sign-in types anything',
    { timeout: 120_000 },
    async () => {
      // A headless run shows nothing, and the config chooses both the host and which
      // variables reach it — so this line is the only place a lookalike is visible.
      process.env['FIXTURE_USER'] = 'Ada'
      process.env['FIXTURE_PASSWORD'] = 'hunter2'
      const { run } = project({
        verify: '#account',
        allowEnv: ['FIXTURE_USER', 'FIXTURE_PASSWORD'],
      })
      const said: string[] = []
      await signIn(run, 'admin', {
        using: 'sign-in',
        say: (line) => said.push(line),
      })
      // First, before the browser is even started: after the fact is after the typing.
      expect(said[0]).toBe(
        `Signing in at ${origin}/signin.html with \`sign-in\`, which may type ` +
          'FIXTURE_USER, FIXTURE_PASSWORD into it.',
      )
    },
  )

  it('says it without a variable list when nothing granted any', { timeout: 120_000 }, async () => {
    const made = withSignIn({ verify: '#account' }, signInAt(origin, 'Ada'))
    const said = await login(made)
    expect(said.split('\n')[0]).toBe(`Signing in at ${origin}/signin.html with \`via-provider\`.`)
  })

  it(
    'signs in with a macro, and writes a session that a later shot is signed in by',
    { timeout: 120_000 },
    async () => {
      process.env['FIXTURE_USER'] = 'Ada'
      process.env['FIXTURE_PASSWORD'] = 'hunter2'
      const { run, root } = project({
        verify: '#account',
        allowEnv: ['FIXTURE_USER', 'FIXTURE_PASSWORD'],
      })
      const said: string[] = []
      await signIn(run, 'admin', {
        using: 'sign-in',
        say: (line) => said.push(line),
      })

      const file = join(root, '.shotlist/admin.json')
      expect(existsSync(file)).toBe(true)
      expect(said.join('\n')).toContain(file)
      // The cookie is what the next run is signed in by, so it has to be in there.
      expect(JSON.stringify(readSession(run, sessionFor(run, 'admin', 'x')))).toContain(
        'fixture-session',
      )
      // Windows has no mode bits to set, so there is nothing to assert there.
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o777).toBe(0o600)
      }

      writeFileSync(
        join(root, 'recipes', 'dash.yaml'),
        `name: dash\nsession: admin\nclip: { css: '#account' }\n`,
      )
      const captureRun = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
      const result = await shoot(captureRun, captureRun.project.library.recipes.get('dash')!)
      expect(existsSync(result.file)).toBe(true)
    },
  )

  it('refuses to sign in by hand where there is no terminal to wait in', async () => {
    const { run } = project()
    await expect(signIn(run, 'admin', { say: () => {} })).rejects.toThrow(/--using <macro>/)
  })

  it(
    'writes nothing when the sign-in did not take, rather than a session of the form',
    { timeout: 120_000 },
    async () => {
      process.env['FIXTURE_USER'] = 'Ada'
      // No password, so the fixture refuses and `#account` never appears.
      process.env['FIXTURE_PASSWORD'] = 'x'
      const { run, root } = project({
        verify: '#nothing-with-this-id',
        allowEnv: ['FIXTURE_USER', 'FIXTURE_PASSWORD'],
      })
      await expect(
        signIn(run, 'admin', {
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
      const { root } = project({ verify: '#account' })
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
      const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
      await expect(shoot(run, run.project.library.recipes.get('dash')!)).rejects.toThrow(
        /most likely expired/,
      )
    },
  )
})
