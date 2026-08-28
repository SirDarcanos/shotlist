import { createServer } from 'node:http'
import type { Server } from 'node:http'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { drawAnnotations, loadPlaywright, openRun, parseConfig } from '../src/index.js'
import { shoot } from '../src/capture.js'
import type { Run } from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** A throwaway copy of the fixture Project opened as a Run. */
function project() {
  const root = tempProject()
  const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
  return { root, run, loaded: run.project, library: run.project.library }
}

/** Open a Run after replacing one fixture Recipe on disk. */
function recipeProject(name: string, patch: Record<string, unknown>) {
  const initial = project()
  const recipe = initial.library.recipes.get(name)!
  writeFileSync(
    join(initial.root, `recipes/zz-${name}.json`),
    JSON.stringify({ ...recipe, ...patch }),
  )
  const destinations =
    typeof patch['url'] === 'string' && /^https?:\/\//.test(patch['url'])
      ? [new URL(patch['url']).origin]
      : []
  const run = openRun(
    { untrusted: false, destinations },
    join(initial.root, 'shotlist.config.yaml'),
  )
  return {
    root: initial.root,
    run,
    loaded: run.project,
    library: run.project.library,
    recipe: run.project.library.recipes.get(name)!,
  }
}

/** A PNG's pixel size, read from its header. */
function pngSize(file: string): { width: number; height: number } {
  const png = readFileSync(file)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

afterAll(removeProjects)

describe('teardown', () => {
  /**
   * Serve the fixture over http and record every path asked for.
   *
   * A teardown's whole point is what it leaves behind in the application rather than in
   * the browser, and the browser is thrown away before a test could look at it. The
   * request log is the only place the two are visible together.
   */
  function serve(): Promise<{ origin: string; seen: string[]; close: () => Promise<void> }> {
    const seen: string[] = []
    return new Promise((ready) => {
      const server: Server = createServer((request, response) => {
        const { pathname } = new URL(request.url ?? '/', 'http://localhost')
        seen.push(pathname)
        try {
          response.end(readFileSync(join(HERE, 'fixture', pathname.replace(/^\/+/, ''))))
        } catch {
          response.statusCode = 404
          response.end('not found')
        }
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        ready({
          origin: `http://127.0.0.1:${port}`,
          seen,
          close: () => new Promise((done) => server.close(() => done())),
        })
      })
    })
  }

  /**
   * Shoot one recipe against the served fixture, and hand back what the server saw.
   *
   * The recipe is built from the origin because the port is only known once the server
   * is up, and `goto` takes a whole URL. Named `dash` rather than anything with the word
   * teardown in it: one of these asserts on an error that must not mention it.
   */
  async function shootServed(build: (origin: string) => Record<string, unknown>) {
    const server = await serve()
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes/dash.json'),
      JSON.stringify({ name: 'dash', url: `${server.origin}/index.html`, ...build(server.origin) }),
    )
    const run = openRun(
      { untrusted: false, destinations: [server.origin] },
      join(root, 'shotlist.config.yaml'),
    )
    const recipe = run.project.library.recipes.get('dash')!
    try {
      // Settled into a value rather than rethrown, so the caller can assert on the
      // failure and on the request log together — and so the server is still up while
      // the shot is taken, which returning the promise would not manage.
      return {
        seen: server.seen,
        ...(await shoot(run, recipe).then(
          (result) => ({ result, why: '' }),
          (error: unknown) => ({ result: undefined, why: (error as Error).message }),
        )),
      }
    } finally {
      await server.close()
    }
  }

  // The modal is `hidden` until the row's button is clicked, so a clip of its card is a
  // box with area only after the setup has run.
  const OPEN = { click: { css: '.row button' } }
  const CARD = { css: '#modal .card' }

  it('runs after the shot has been taken, not before it', { timeout: 120_000 }, async () => {
    // The clip is of something only the setup state has, and the teardown navigates away
    // from the page entirely — so this shot comes back at all only if the order is right.
    const { seen, result } = await shootServed((origin) => ({
      setup: [OPEN],
      clip: CARD,
      teardown: [{ goto: `${origin}/TORN_DOWN` }],
    }))
    expect(existsSync(result!.file)).toBe(true)
    expect(seen).toEqual(['/index.html', '/TORN_DOWN'])
  })

  it('runs after a shot that failed, which is when it matters most', async () => {
    const { seen, why } = await shootServed((origin) => ({
      clip: { css: '#nothing-here' },
      teardown: [{ goto: `${origin}/TORN_DOWN` }],
    }))
    expect(why).toMatch(/clip — no element matched/)
    expect(seen).toContain('/TORN_DOWN')
  }, 120_000)

  it('says so when it is the teardown that failed, and the shot did not', async () => {
    const { why } = await shootServed(() => ({
      setup: [OPEN],
      clip: CARD,
      teardown: [{ click: { css: '#nothing-here' } }],
    }))
    expect(why).toMatch(/recipe "dash": teardown — .*no element matched/s)
  }, 120_000)

  it('leaves the reason a shot failed as the reason, rather than the tidying up', async () => {
    // Both fail here. The clip is why there is no screenshot; the teardown is a footnote
    // about a page that was already in a state nobody planned.
    const { why } = await shootServed(() => ({
      clip: { css: '#nothing-here' },
      teardown: [{ click: { css: '#also-nothing' } }],
    }))
    expect(why).toMatch(/clip — no element matched/)
    expect(why).not.toMatch(/teardown/)
  }, 120_000)
})

describe('shoot', () => {
  it(
    'drives the page, clips a region, draws the callouts and installs the image',
    { timeout: 120_000 },
    async () => {
      const { run, library } = project()
      const recipe = library.recipes.get('order-row')!
      const result = await shoot(run, recipe, { install: true })

      expect(existsSync(result.file)).toBe(true)
      expect(result.installed).toMatch(/installed\/order-row\.png$/)
      expect(existsSync(result.installed!)).toBe(true)

      // The canvas is wider than the clip because a label sits in a margin on each side.
      const clipWidth = 400 + 12 * 2
      expect(result.size.width).toBeGreaterThan(clipWidth)
      const pixels = pngSize(result.file)
      expect(pixels.width).toBe(result.size.width * 2)
    },
  )

  it('numbers marks in the order the recipe lists them', { timeout: 120_000 }, async () => {
    const { run, library } = project()
    const recipe = library.recipes.get('modal')!
    expect(recipe.callouts.map((c) => [c.mark, c.n])).toEqual([
      ['bar', 1],
      ['detail', 2],
      ['actions', 3],
    ])

    const result = await shoot(run, recipe)
    expect(existsSync(result.file)).toBe(true)
    // The top bar runs edge to edge, so its box and its disc would both be sliced by
    // the shot's own boundary — the canvas grows instead.
    expect(result.size.width).toBeGreaterThan(1000)
    expect(result.size.height).toBeGreaterThan(700)
  })

  it('refuses an undefined Install destination only when Installation is requested', async () => {
    const { run, recipe } = recipeProject('modal', { install: 'nowhere' })
    await expect(shoot(run, recipe)).resolves.toMatchObject({ name: 'modal' })
    await expect(shoot(run, recipe, { install: true })).rejects.toThrow(
      /installs to "nowhere".*it defines guide/s,
    )
  })

  it('authorizes a Recipe URL immediately before navigation through its Run', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes/outside.yaml'),
      'name: outside\nurl: https://outside.example.test/private\nclip: viewport\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const recipe = run.project.library.recipes.get('outside')!
    let contexts = 0
    let navigations = 0
    const browser = {
      newContext: () => {
        contexts++
        return Promise.resolve({
          newPage: () =>
            Promise.resolve({
              goto: () => {
                navigations++
                return Promise.resolve()
              },
            }),
          route: () => Promise.resolve(),
          routeWebSocket: () => Promise.resolve(),
          close: () => Promise.resolve(),
        })
      },
      close: () => Promise.resolve(),
    }

    await expect(shoot(run, recipe, { browser: browser as never })).rejects.toThrow(
      /recipe "outside": Network destination https:\/\/outside\.example\.test is not approved/,
    )
    expect(contexts).toBe(1)
    expect(navigations).toBe(0)
  })
})

// A query is resolved by a function serialized into the browser, so a failure arrives as
// `page.evaluateHandle: Error: …` with a JavaScript stack through `UtilityScript`. The
// person reading it is editing YAML: it has to say which recipe, and which key in it.
describe('a query that matches nothing', () => {
  /** Shoot `order-row` with one key replaced, and return the error it threw. */
  async function failure(patch: Record<string, unknown>): Promise<Error> {
    const { run, recipe } = recipeProject('order-row', patch)
    return shoot(run, recipe).then(
      () => {
        throw new Error('the shot was expected to fail')
      },
      (error: Error) => error,
    )
  }

  const nowhere = { css: '.no-such-thing-anywhere' }

  it('names the recipe and the mark', { timeout: 120_000 }, async () => {
    const error = await failure({ marks: { amount: nowhere }, callouts: [] })
    expect(error.message).toBe(
      'recipe "order-row": marks.amount — no element matched {"css":".no-such-thing-anywhere"}',
    )
  })

  it('names the clip', { timeout: 120_000 }, async () => {
    const error = await failure({ clip: nowhere, marks: {}, callouts: [] })
    expect(error.message).toMatch(/^recipe "order-row": clip — no element matched /)
  })

  it('names the step that could not find its element', { timeout: 120_000 }, async () => {
    const error = await failure({ setup: [{ click: nowhere }], marks: {}, callouts: [] })
    expect(error.message).toMatch(/^recipe "order-row": setup — `click`: no element matched /)
  })

  it("keeps Playwright's own wrapping out of it", { timeout: 120_000 }, async () => {
    const error = await failure({ marks: { amount: nowhere }, callouts: [] })
    expect(error.message).not.toMatch(/evaluateHandle|UtilityScript|\n\s+at /)
  })
})

describe('a site that is not up', () => {
  it('names the key holding the url, and asks whether it is running', async () => {
    // Port 1 is reserved, so nothing can be listening on it and the connection is
    // refused rather than left to time out.
    const { run, recipe } = recipeProject('order-row', { url: 'http://127.0.0.1:1/' })
    await expect(shoot(run, recipe)).rejects.toThrow(
      /^recipe "order-row": `url` — could not open http:\/\/127\.0\.0\.1:1\/ — .*Is the site running\?$/s,
    )
  }, 120_000)
})

// A capture drives a real application, so some of what it trips over is gone a second
// later. `retries` is the recipe saying which of its shots are like that.
describe('retries', () => {
  /** A browser that fails every context, counting how many were asked for. */
  function broken() {
    const contexts: number[] = []
    return {
      contexts,
      browser: {
        newContext: () => {
          contexts.push(contexts.length + 1)
          return Promise.reject(new Error('the context could not be opened'))
        },
        close: () => Promise.resolve(),
      },
    }
  }

  it('shoots once when the recipe asks for no retries', async () => {
    const { run, library } = project()
    const { browser, contexts } = broken()
    const recipe = library.recipes.get('order-row')!
    await expect(shoot(run, recipe, { browser })).rejects.toThrow()
    expect(contexts.length).toBe(1)
  })

  it('shoots one more time per retry, and no more', async () => {
    const { run, recipe } = recipeProject('order-row', { retries: 2 })
    const { browser, contexts } = broken()
    await expect(shoot(run, recipe, { browser })).rejects.toThrow('the context could not be opened')
    expect(contexts.length).toBe(3)
  })

  it('reports each failed attempt as it happens, with what went wrong', async () => {
    const { run, recipe } = recipeProject('order-row', { retries: 2 })
    const { browser } = broken()
    const seen: string[] = []
    await expect(
      shoot(run, recipe, {
        browser,
        onRetry: (retry) => seen.push(`${retry.attempt}/${retry.of} ${retry.why}`),
      }),
    ).rejects.toThrow()
    // Two reports, not three: the last attempt is a failure, not a retry.
    expect(seen).toEqual([
      '1/3 the context could not be opened',
      '2/3 the context could not be opened',
    ])
  })

  it('does not retry a Work limit failure', { timeout: 120_000 }, async () => {
    const root = tempProject()
    rmSync(join(root, 'recipes'), { recursive: true })
    rmSync(join(root, 'macros'), { recursive: true })
    mkdirSync(join(root, 'recipes'))
    writeFileSync(
      join(root, 'recipes/timed.yaml'),
      'name: timed\nretries: 2\nsetup:\n  - optional: []\nclip: viewport\n',
    )
    const run = openRun(
      { untrusted: false, workLimits: { recipeMilliseconds: 1 } },
      join(root, 'shotlist.config.yaml'),
    )
    const recipe = run.project.library.recipes.get('timed')!
    const retries: unknown[] = []

    const error = await shoot(run, recipe, {
      onRetry: (retry) => retries.push(retry),
    }).then(
      () => new Error('the Work limit did not fail'),
      (caught: unknown) => caught as Error,
    )
    expect(error.message).toMatch(/Work limit/)
    expect(error.message.match(/The Operator may raise it/g)).toHaveLength(1)
    expect(retries).toEqual([])
  })

  it('keeps the Run and its authorized output target across retries', async () => {
    const root = tempProject()
    writeFileSync(join(root, 'recipes/retried.yaml'), 'name: retried\nretries: 1\nclip: viewport\n')
    rmSync(join(root, 'out'), { recursive: true, force: true })
    mkdirSync(join(root, 'first'))
    mkdirSync(join(root, 'second'))
    symlinkSync('first', join(root, 'out'))
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const recipe = run.project.library.recipes.get('retried')!
    const real = await loadPlaywright().chromium.launch()
    let contexts = 0
    let closes = 0
    const browser = {
      newContext: (options?: Record<string, unknown>) => {
        contexts++
        return contexts === 1
          ? Promise.reject(new Error('a flake'))
          : real.newContext(options as never)
      },
      close: () => {
        closes++
        return Promise.resolve()
      },
    }
    try {
      const result = await shoot(run, recipe, {
        browser,
        onRetry: () => {
          rmSync(join(root, 'out'))
          symlinkSync('second', join(root, 'out'))
        },
      })
      expect(contexts).toBe(2)
      expect(closes).toBe(0)
      expect(result.file).toBe(join(root, 'out/retried.png'))
      expect(existsSync(join(root, 'first/retried.png'))).toBe(true)
      expect(existsSync(join(root, 'second/retried.png'))).toBe(false)
    } finally {
      await real.close()
    }
  }, 120_000)

  it('returns the shot when a later attempt succeeds', { timeout: 120_000 }, async () => {
    const { run, recipe } = recipeProject('order-row', { retries: 1 })
    const real = await loadPlaywright().chromium.launch()
    let contexts = 0
    // Fails once, then behaves. Nothing about the recipe is wrong, which is the case
    // `retries` exists for: the same shot taken again is the whole fix.
    const flaky = {
      newContext: (options?: Record<string, unknown>) =>
        ++contexts === 1 ? Promise.reject(new Error('a flake')) : real.newContext(options as never),
      close: () => Promise.resolve(),
    }
    try {
      const result = await shoot(run, recipe, { browser: flaky })
      expect(existsSync(result.file)).toBe(true)
    } finally {
      await real.close()
    }
  })

  it('never retries `source: file`, which has no page to be flaky about', async () => {
    const { run, recipe } = recipeProject('annotated', {
      file: 'incoming/not-here.png',
      retries: 3,
    })
    const seen: string[] = []
    await expect(
      shoot(run, recipe, {
        browser: {
          newContext: () => Promise.reject(new Error('a browser was used')),
          close: () => Promise.resolve(),
        },
        onRetry: (retry) => seen.push(retry.why),
      }),
    ).rejects.toThrow(/no file at /)
    expect(seen).toEqual([])
  })
})

describe('source: file', () => {
  it(
    'shoots and installs through its Run with a local font and an owned browser',
    { timeout: 120_000 },
    async () => {
      const root = tempProject()
      mkdirSync(join(root, 'fonts'))
      copyFileSync(join(HERE, 'fixture/JetBrainsMono-Bold.woff2'), join(root, 'fonts/mono.woff2'))
      writeFileSync(
        join(root, 'fonts/mono.css'),
        "@font-face { font-family: 'Shotlist Mono'; src: url('mono.woff2') format('woff2'); }",
      )
      const configFile = join(root, 'shotlist.config.yaml')
      writeFileSync(
        configFile,
        readFileSync(configFile, 'utf8').replace(
          '  label:\n    fill:',
          '  label:\n    font: Shotlist Mono\n    fontUrl: fonts/mono.css\n    fill:',
        ),
      )
      const run = openRun({ untrusted: false }, configFile)
      const recipe = run.project.library.recipes.get('annotated')!

      const result = await shoot(run, recipe, { install: true })

      expect(existsSync(result.file)).toBe(true)
      expect(existsSync(result.installed!)).toBe(true)
      expect(result.warnings).toBeUndefined()
    },
  )

  it(
    'annotates an image already on disk, with no page to query',
    { timeout: 120_000 },
    async () => {
      const { run, library } = project()
      const recipe = library.recipes.get('annotated')!
      const result = await shoot(run, recipe, { install: true })

      expect(existsSync(result.file)).toBe(true)
      expect(existsSync(result.installed!)).toBe(true)

      // The source is 600×280 image pixels, which is 300×140 at the project's 2× scale.
      // The label sits in a margin the canvas grows to the right, so it is wider than
      // the source and exactly as tall.
      expect(result.size.height).toBe(140)
      expect(result.size.width).toBeGreaterThan(300)
      expect(pngSize(result.file).width).toBe(result.size.width * 2)
    },
  )

  it('refuses an untrusted File Recipe path escape through its Run', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes/outside-file.yaml'),
      'name: outside-file\nsource: file\nfile: /etc/hosts\nclip: viewport\n',
    )
    const run = openRun({ untrusted: true }, join(root, 'shotlist.config.yaml'))
    const recipe = run.project.library.recipes.get('outside-file')!

    await expect(shoot(run, recipe, { browser: unusable as never })).rejects.toThrow(
      /recipe "outside-file": `file:`: \/etc\/hosts is outside the project/,
    )
  })

  it('keeps secret-looking File Recipe paths forbidden for a trusted Run', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes/secret-file.yaml'),
      'name: secret-file\nsource: file\nfile: .env\nclip: viewport\n',
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const recipe = run.project.library.recipes.get('secret-file')!

    await expect(shoot(run, recipe, { browser: unusable as never })).rejects.toThrow(
      /recipe "secret-file": `file:`: "\.env" is a forbidden path/,
    )
  })

  it('keeps control characters forbidden in File Recipe paths for a trusted Run', async () => {
    const root = tempProject()
    writeFileSync(
      join(root, 'recipes/control-file.json'),
      JSON.stringify({ name: 'control-file', source: 'file', file: 'incoming/\u0001.png' }),
    )
    const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
    const recipe = run.project.library.recipes.get('control-file')!

    await expect(shoot(run, recipe, { browser: unusable as never })).rejects.toThrow(
      /recipe "control-file": `file:`: .* holds a control character/,
    )
  })

  it('authorizes an untrusted Run output before creating it', async () => {
    const root = tempProject()
    const escapedName = `${basename(root)}-escaped-output`
    const escaped = join(root, '..', escapedName)
    const configFile = join(root, 'shotlist.config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace('  out: out', `  out: ../${escapedName}`),
    )
    const run = openRun({ untrusted: true }, configFile)
    const recipe = run.project.library.recipes.get('annotated')!

    await expect(shoot(run, recipe, { browser: unusable as never })).rejects.toThrow(
      /paths\.out: .* is outside the project/,
    )
    expect(existsSync(escaped)).toBe(false)
  })

  it('authorizes an untrusted Run install destination before creating it', async () => {
    const root = tempProject()
    const escapedName = `${basename(root)}-escaped-install`
    const escaped = join(root, '..', escapedName)
    writeFileSync(
      join(root, 'recipes/plain.yaml'),
      'name: plain\nsource: file\nfile: incoming/invoice.png\ninstall: guide\n',
    )
    const configFile = join(root, 'shotlist.config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace('  guide: installed', `  guide: ../${escapedName}`),
    )
    const run = openRun({ untrusted: true }, configFile)
    const recipe = run.project.library.recipes.get('plain')!

    await expect(shoot(run, recipe, { install: true, browser: unusable as never })).rejects.toThrow(
      /recipe "plain": install\."guide": .* is outside the project/,
    )
    expect(existsSync(escaped)).toBe(false)
  })

  it('refuses a mark that queries the page, since there is no page', async () => {
    const { run, recipe } = recipeProject('annotated', {
      marks: { due: { css: '.card' } },
    })
    await expect(shoot(run, recipe)).rejects.toThrow(
      /^recipe "annotated": marks\.due — queries the page, but `source: file` has no page — give it a `rect: \[x, y, width, height\]`$/,
    )
  })

  // Both are mistakes made while writing the recipe, so both are refused before a browser
  // is needed at all. `unusable` fails the test if one is reached: without it, "reported
  // early" is a claim no assertion here would notice being broken.
  const unusable = {
    newContext: () => Promise.reject(new Error('a browser was used')),
    close: () => Promise.resolve(),
  }

  it('says where it looked for a file that is not there', async () => {
    const { run, recipe } = recipeProject('annotated', { file: 'incoming/not-here.png' })
    await expect(shoot(run, recipe, { browser: unusable })).rejects.toThrow(
      /^recipe "annotated": `file:` — no file at .*incoming\/not-here\.png — a relative path is resolved from the config file's directory$/,
    )
  })

  it('says a file that is not an image is not one, rather than failing on its header', async () => {
    const { run, recipe } = recipeProject('annotated', { file: 'shotlist.config.yaml' })
    await expect(shoot(run, recipe, { browser: unusable })).rejects.toThrow(
      /^recipe "annotated": `file:` — shotlist\.config\.yaml is not a PNG, JPEG or WebP — /,
    )
  })
})

describe('style in a real browser', () => {
  /** Shoot `annotated` with a style override, and report the canvas and any warnings. */
  async function withStyle(style: Record<string, unknown>) {
    const { run, recipe } = recipeProject('annotated', { style })
    return shoot(run, recipe)
  }

  it(
    'lays a serif out differently from a sans, because it measures the real font',
    { timeout: 120_000 },
    async () => {
      // Generic families, not Arial and Georgia: those are Microsoft's, absent from a
      // stock Linux runner, and the test would measure two fallbacks against each other
      // and warn about both.
      const sans = await withStyle({ label: { font: 'sans-serif' } })
      const serif = await withStyle({ label: { font: 'serif' } })
      // The label sits in a margin sized to its width, so a wider face makes a wider shot.
      expect(serif.size.width).not.toBe(sans.size.width)
      expect(sans.warnings).toBeUndefined()
      expect(serif.warnings).toBeUndefined()
    },
  )

  it(
    'warns when the font named is not installed, rather than silently using another',
    { timeout: 120_000 },
    async () => {
      const result = await withStyle({
        label: { font: '"Absolutely Not Installed", "Also Not Installed", serif' },
      })
      expect(result.warnings?.[0]).toMatch(/none of them is available/)
      // It still produced an image: a fallback is worth saying, not worth failing over.
      expect(existsSync(result.file)).toBe(true)
    },
  )

  it('draws on a light canvas as readily as a dark one', { timeout: 120_000 }, async () => {
    const light = await withStyle({ canvas: '#FFFFFF', color: '#B91C1C' })
    expect(existsSync(light.file)).toBe(true)
    expect(light.size.width).toBeGreaterThan(300)
  })

  it('shoots at a scale other than two', { timeout: 120_000 }, async () => {
    const { run, recipe } = recipeProject('annotated', { scale: 1 })
    const result = await shoot(run, recipe)
    // The source is 600×280 image pixels, which at 1x is 600×280 CSS pixels.
    expect(result.size.height).toBe(280)
    expect(pngSize(result.file).width).toBe(result.size.width)
  })
})

describe('arrow placement in a real browser', () => {
  // jsdom has no canvas, so the metric-box fallback is all a unit test can reach. The
  // path that measures real glyph ink only runs in a browser, and it is the one that has
  // been wrong: a label's arrow left from inside its first line rather than between them.
  it('leaves a two-line label from between its lines', { timeout: 120_000 }, async () => {
    const browser = await loadPlaywright().chromium.launch()
    try {
      const context = await browser.newContext({
        viewport: { width: 460, height: 320 },
        deviceScaleFactor: 2,
      })
      const page = await context.newPage()
      await page.setContent('<style>html,body{margin:0}</style><img id="shotlist-image">')
      const style = parseConfig({ site: { url: 'http://x' } }).style
      await page.evaluate(drawAnnotations, {
        image: { width: 460, height: 320 },
        scale: 2,
        style: { ...style, label: { ...style.label, stroke: style.color } } as never,
        marks: [
          {
            rect: { x: 20, y: 140, width: 30, height: 30 },
            text: ['Drag to move', 'a combatant'],
            place: 'right' as const,
            badge: 'tl' as const,
            box: true,
            inside: true,
            gap: 260,
          },
        ],
      })

      const measured = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('#shotlist-layer text')]
        const context = document.createElement('canvas').getContext('2d')!
        const first = texts[0] as SVGTextElement
        context.font = window.getComputedStyle(first).font
        const inkOf = (node: Element) => {
          const anchor = Number(node.getAttribute('y'))
          const box = (node as SVGTextElement).getBBox()
          return { top: box.y, bottom: box.y + box.height, anchor }
        }
        const points = document
          .querySelector('#shotlist-layer polygon')!
          .getAttribute('points')!
          .split(' ')
          .map((pair) => Number(pair.split(',')[1]))
        return {
          lineOne: inkOf(texts[0]!),
          lineTwo: inkOf(texts[1]!),
          // The tail is the widest part of the shaft, furthest from the tip.
          tail: Math.max(...points) - (Math.max(...points) - Math.min(...points)) / 2,
        }
      }, undefined)

      // In the gap between the two lines — a band a few pixels wide, not merely
      // somewhere within the block. Measuring a label against a different baseline from
      // the one it is drawn with put the tail most of a line above this.
      // The metric boxes very nearly touch, so a couple of pixels of slack — still a
      // far narrower band than the fault this pins, which was most of a line.
      const slack = 2
      expect(measured.tail).toBeGreaterThanOrEqual(measured.lineOne.bottom - slack)
      expect(measured.tail).toBeLessThanOrEqual(measured.lineTwo.top + slack)
    } finally {
      await browser.close()
    }
  })
})

// A local stylesheet cannot be linked: the drawing page is built with `setContent`, so it
// has no file origin and a browser refuses it a `file:` subresource — silently, which is
// worse than refusing it loudly. It is read and inlined instead, fonts and all.
describe('a font the project ships itself', () => {
  const FONT = join(HERE, 'fixture/JetBrainsMono-Bold.woff2')

  const SHEET = `@font-face {
    font-family: 'Shotlist Mono';
    src: url('JetBrainsMono-Bold.woff2') format('woff2');
    font-weight: 700;
  }`

  /**
   * A project whose labels are set in a font it ships.
   *
   * The family is named with no fallback on purpose. A stack that ends in Arial resolves
   * whatever happens to the webfont, and the warning — the only signal here that the font
   * arrived — would stay silent either way.
   */
  function withFont(
    css: string,
    fontUrl: string | ((root: string) => string),
    font = 'Shotlist Mono',
  ) {
    const root = tempProject()
    mkdirSync(join(root, 'fonts'), { recursive: true })
    writeFileSync(join(root, 'fonts/mono.css'), css)
    copyFileSync(FONT, join(root, 'fonts/JetBrainsMono-Bold.woff2'))
    const configFile = join(root, 'shotlist.config.yaml')
    const url = typeof fontUrl === 'string' ? fontUrl : fontUrl(root)
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(
        '  label:\n    fill:',
        `  label:\n    font: ${font}\n    fontUrl: ${JSON.stringify(url)}\n    fill:`,
      ),
    )
    const run = openRun({ untrusted: false }, configFile)
    return { run, loaded: run.project, library: run.project.library }
  }

  const shootIt = (run: Run) => shoot(run, run.project.library.recipes.get('order-row')!)

  it('is silent about a font that arrived, and says so when one did not', async () => {
    // Both halves, because either alone passes for the wrong reason: a stylesheet that
    // loads nothing is the control that proves the silence means something.
    const arrived = withFont(SHEET, 'fonts/mono.css')
    expect((await shootIt(arrived.run)).warnings ?? []).toEqual([])

    const missing = withFont('/* defines no family */', 'fonts/mono.css')
    expect((await shootIt(missing.run)).warnings?.[0]).toMatch(
      /names Shotlist Mono, and none of them is available/,
    )
  }, 120_000)

  it('loads one named by an absolute file: URL', { timeout: 120_000 }, async () => {
    const { run } = withFont(SHEET, (root) => pathToFileURL(join(root, 'fonts/mono.css')).href)
    expect((await shootIt(run)).warnings ?? []).toEqual([])
  })

  // The stylesheet is the general case; a project that licensed one face and dropped the
  // file in should not have to write two lines of `@font-face` to say so.
  it('takes the font file itself, and declares it under the family the labels ask for', async () => {
    const { run } = withFont(SHEET, 'fonts/JetBrainsMono-Bold.woff2')
    // `font` is `Shotlist Mono` with no fallback, so silence here means the file was read,
    // declared under that name and resolved — the same signal the stylesheet test uses.
    expect((await shootIt(run)).warnings ?? []).toEqual([])
  }, 120_000)

  it('refuses a font file when the stack names no family to declare it under', async () => {
    const { run } = withFont(SHEET, 'fonts/JetBrainsMono-Bold.woff2', 'sans-serif')
    await expect(shootIt(run)).rejects.toThrow(/style\.label\.font has to name the family/)
  }, 120_000)

  it('says where it looked for a stylesheet that is not there', async () => {
    const { run } = withFont(SHEET, 'fonts/missing.css')
    await expect(shootIt(run)).rejects.toThrow(
      /style\.label\.fontUrl: nothing at .*fonts\/missing\.css/,
    )
  }, 120_000)

  it('treats a value that is markup as the path it is not, rather than as markup', async () => {
    // It used to be interpolated into a `<link href>`, where a quote closed the attribute
    // and opened a script tag — in the page holding the screenshot.
    const { run } = withFont(SHEET, '"><script>globalThis.PWNED=1</script>')
    await expect(shootIt(run)).rejects.toThrow(/nothing at /)
  }, 120_000)

  it('resolves a symlinked stylesheet asset from the authored location', async () => {
    const root = tempProject()
    mkdirSync(join(root, 'fonts'))
    mkdirSync(join(root, 'shared'))
    copyFileSync(FONT, join(root, 'fonts/mono.woff2'))
    writeFileSync(
      join(root, 'shared/mono.css'),
      "@font-face { font-family: 'Shotlist Mono'; src: url('mono.woff2') format('woff2'); }",
    )
    symlinkSync('../shared/mono.css', join(root, 'fonts/linked.css'))
    const configFile = join(root, 'shotlist.config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(
        '  label:\n    fill:',
        '  label:\n    font: Shotlist Mono\n    fontUrl: fonts/linked.css\n    fill:',
      ),
    )
    const run = openRun({ untrusted: false }, configFile)
    const recipe = run.project.library.recipes.get('annotated')!

    expect((await shoot(run, recipe)).warnings).toBeUndefined()
  }, 120_000)

  it('authorizes a remote stylesheet through the Run before loading it', async () => {
    const root = tempProject()
    const configFile = join(root, 'shotlist.config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(
        '  label:\n    fill:',
        '  label:\n    font: Shotlist Mono\n    fontUrl: https://outside.example.test/mono.css\n    fill:',
      ),
    )
    const run = openRun({ untrusted: false }, configFile)
    const recipe = run.project.library.recipes.get('annotated')!
    await expect(shoot(run, recipe)).rejects.toThrow(
      /recipe "annotated": Network destination https:\/\/outside\.example\.test is not approved/,
    )
  })

  it('authorizes a remote asset in a local stylesheet through the Run', async () => {
    const root = tempProject()
    mkdirSync(join(root, 'fonts'))
    writeFileSync(
      join(root, 'fonts/mono.css'),
      "@font-face { font-family: 'Shotlist Mono'; src: url('https://outside.example.test/mono.woff2'); }",
    )
    const configFile = join(root, 'shotlist.config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(
        '  label:\n    fill:',
        '  label:\n    font: Shotlist Mono\n    fontUrl: fonts/mono.css\n    fill:',
      ),
    )
    const run = openRun({ untrusted: false }, configFile)
    const recipe = run.project.library.recipes.get('annotated')!
    await expect(shoot(run, recipe)).rejects.toThrow(
      /recipe "annotated": Network destination https:\/\/outside\.example\.test is not approved/,
    )
  })

  it('authorizes a local stylesheet path through the Run before reading it', async () => {
    const root = tempProject()
    const configFile = join(root, 'shotlist.config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(
        '  label:\n    fill:',
        '  label:\n    font: Shotlist Mono\n    fontUrl: fonts/.env.css\n    fill:',
      ),
    )
    const run = openRun({ untrusted: false }, configFile)
    const recipe = run.project.library.recipes.get('annotated')!
    const browser = {
      newContext: () => Promise.reject(new Error('the stylesheet policy was bypassed')),
      close: () => Promise.resolve(),
    }

    await expect(shoot(run, recipe, { browser: browser as never })).rejects.toThrow(
      /style\.label\.fontUrl: "\.env\.css" is a forbidden path/,
    )
  })

  it('authorizes a local stylesheet asset through the Run before reading it', async () => {
    const root = tempProject()
    mkdirSync(join(root, 'fonts'))
    writeFileSync(
      join(root, 'fonts/mono.css'),
      "@font-face { font-family: 'Shotlist Mono'; src: url('denied.woff2') format('woff2'); }",
    )
    writeFileSync(join(root, 'fonts/denied.woff2'), 'not read')
    const configFile = join(root, 'shotlist.config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8')
        .replace(
          '  label:\n    fill:',
          '  label:\n    font: Shotlist Mono\n    fontUrl: fonts/mono.css\n    fill:',
        )
        .concat('\ndeny: [denied.woff2]\n'),
    )
    const run = openRun({ untrusted: false }, configFile)
    const recipe = run.project.library.recipes.get('annotated')!

    await expect(shoot(run, recipe)).rejects.toThrow(
      /style\.label\.fontUrl: "denied\.woff2" is a forbidden path/,
    )
  }, 120_000)

  it('says which font a stylesheet points at when that is missing', async () => {
    const { run } = withFont(
      "@font-face { font-family: 'X'; src: url('gone.woff2'); }",
      'fonts/mono.css',
    )
    await expect(shootIt(run)).rejects.toThrow(
      /mono\.css points at gone\.woff2, and there is no file there/,
    )
  }, 120_000)
})
