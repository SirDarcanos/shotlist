import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
