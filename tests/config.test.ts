import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ShotlistError,
  findConfig,
  fromRoot,
  loadConfig,
  mergeStyle,
  parseConfig,
  readDocument,
} from '../src/config.js'

/** A throwaway directory holding the given files, keyed by relative path. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shotlist-'))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

describe('parseConfig', () => {
  it('fills every default from a config that only names the site', () => {
    const config = parseConfig({ site: { url: 'http://localhost:3000' } })
    expect(config.site.scale).toBe(2)
    expect(config.site.viewport).toEqual({ width: 1280, height: 800 })
    expect(config.style.box.width).toBe(6)
    expect(config.paths.recipes).toBe('screenshots/recipes')
    expect(config.install).toEqual({})
  })

  it('carries no default that belongs to one project', () => {
    // Rule 1: nothing about any one site ships in the package. A neutral canvas and a
    // light default are the giveaways to guard — a dark default would suit one app.
    const config = parseConfig({ site: { url: 'http://localhost:3000' } })
    expect(config.site.theme).toBe('light')
    expect(config.style.canvas).toBe('#FFFFFF')
  })

  it('names the missing field rather than dumping the schema', () => {
    expect(() => parseConfig({ style: {} })).toThrow(/site/)
  })

  it('rejects a scale that cannot produce an image', () => {
    expect(() => parseConfig({ site: { url: 'x', scale: 0 } })).toThrow()
  })
})

describe('serve', () => {
  /** The complaint about a config, as the author would see it. */
  function complaint(site: Record<string, unknown>): string {
    try {
      parseConfig({ site: { url: 'http://x', ...site } })
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the config was expected to be refused')
  }

  it('reads a bare string as the command, with everything else defaulted', () => {
    const { serve } = parseConfig({ site: { url: 'http://x', serve: 'npm run dev' } }).site
    expect(serve).toEqual({ command: 'npm run dev', env: {}, timeout: 30000 })
  })

  it('names a misspelled key rather than reporting the shorthand did not match', () => {
    expect(complaint({ serve: { command: 'npm run dev', reddy: 3000 } })).toMatch(
      /site\.serve: unknown key "reddy" — did you mean "ready"\?/,
    )
  })

  it('follows the union inside `ready` too, keeping the whole path', () => {
    expect(complaint({ serve: { command: 'npm run dev', ready: { logg: 'up' } } })).toMatch(
      /site\.serve\.ready: unknown key "logg" — did you mean "log"\?/,
    )
  })
})

describe('mergeStyle', () => {
  it('merges a recipe override one level deep, keeping the rest', () => {
    const base = parseConfig({ site: { url: 'x' } }).style
    const merged = mergeStyle(base, { color: '#000', box: { width: 2 } })
    expect(merged.color).toBe('#000')
    expect(merged.box.width).toBe(2)
    expect(merged.box.radius).toBe(base.box.radius)
    expect(merged.label.size).toBe(base.label.size)
  })

  it('returns the base untouched when there is nothing to override', () => {
    const base = parseConfig({ site: { url: 'x' } }).style
    expect(mergeStyle(base)).toBe(base)
  })
})

describe('loading', () => {
  it('walks up from a nested directory to the nearest config', () => {
    const root = project({
      'shotlist.config.yaml': 'site:\n  url: http://localhost:3000\n',
      'docs/pages/.keep': '',
    })
    expect(findConfig(join(root, 'docs/pages'))).toBe(join(root, 'shotlist.config.yaml'))
  })

  it('resolves project paths against the config file, not the shell', () => {
    const root = project({ 'shotlist.config.yaml': 'site:\n  url: http://x\n' })
    const loaded = loadConfig(join(root, 'shotlist.config.yaml'))
    expect(fromRoot(loaded, 'screenshots/out')).toBe(join(root, 'screenshots/out'))
    expect(fromRoot(loaded, '/tmp/elsewhere')).toBe('/tmp/elsewhere')
  })

  it('says what to do when there is no config at all', () => {
    expect(() => loadConfig(join(tmpdir(), 'nope', 'shotlist.config.yaml'))).toThrow(ShotlistError)
  })

  it('reports a YAML syntax error against its file', () => {
    const root = project({ 'shotlist.config.yaml': 'site:\n  url: "unclosed\n' })
    expect(() => readDocument(join(root, 'shotlist.config.yaml'))).toThrow(/shotlist.config.yaml/)
  })
})

// A config is a file in a repository, and running shotlist in one is not meant to be a
// decision about what that repository may do to the machine.
describe('what a config is not allowed to be', () => {
  const site = { url: 'http://x' }

  it('keeps a finder named __proto__ off Object.prototype', () => {
    const config = parseConfig({ site, finders: JSON.parse('{"__proto__":{"polluted":true}}') })
    expect(Object.keys(config.finders)).toEqual([])
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('takes a fontUrl that is not a URL as a path, which is what a local font is', () => {
    // What it must never be is markup. A value carrying a quote used to close the
    // attribute and open a script tag in the page the callouts are drawn in; it is now
    // escaped there, and anything that is not a http(s) or data: URL never reaches that
    // branch at all — it is read from disk instead.
    for (const fontUrl of ['fonts/mono.css', 'https://fonts.example/x.css', '"><script>x']) {
      expect(() => parseConfig({ site, style: { label: { fontUrl } } }), fontUrl).not.toThrow()
    }
  })

  it('refuses a viewport or scale past what a browser can paint', () => {
    expect(() =>
      parseConfig({ site: { ...site, viewport: { width: 200000, height: 10 } } }),
    ).toThrow(/viewport.width: Too big/)
    expect(() => parseConfig({ site: { ...site, scale: 500 } })).toThrow(/scale: Too big/)
  })
})

describe('the generated schemas', () => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

  it('name the config schema for what it describes', () => {
    const schema = JSON.parse(readFileSync(join(dist, 'config.schema.json'), 'utf8'))
    expect(schema.title).toBe('shotlist config')
    expect(schema.properties.site).toBeDefined()
  })

  it('still answer to the old name, which editors are pointed at by path', () => {
    expect(readFileSync(join(dist, 'schema.json'), 'utf8')).toBe(
      readFileSync(join(dist, 'config.schema.json'), 'utf8'),
    )
  })

  it('declare no $id, so two packages can never claim the same identity', () => {
    for (const file of ['config.schema.json', 'recipe.schema.json', 'macro.schema.json']) {
      expect(JSON.parse(readFileSync(join(dist, file), 'utf8'))['$id']).toBeUndefined()
    }
  })
})
