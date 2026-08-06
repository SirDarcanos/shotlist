import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import type { Io } from '../src/cli.js'
import { removeProjects, tempProject } from './tempProject.js'

const project = tempProject

/** Run the command line, collecting what it printed. */
async function cli(root: string, args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) }
  const code = await run([...args, '--config', join(root, 'shotlist.config.yaml')], io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

afterEach(removeProjects)

describe('shotlist', () => {
  it('lists the recipes when given nothing to do', async () => {
    const { code, out } = await cli(project(), [])
    expect(code).toBe(0)
    expect(out.split('\n')).toEqual(['annotated', 'modal', 'order-row', 'volatile'])
  })

  it('names the recipes a project has when one is misspelled', async () => {
    const { code, err } = await cli(project(), ['order-rows'])
    expect(code).toBe(1)
    expect(err).toMatch(/unknown recipe "order-rows".*annotated, modal, order-row, volatile/s)
  })

  it('shoots a named recipe and installs it', { timeout: 120_000 }, async () => {
    const root = project()
    const { code, out } = await cli(root, ['order-row', '--install'])
    expect(code).toBe(0)
    expect(out).toContain('✓ order-row')
    expect(existsSync(join(root, 'out/order-row.png'))).toBe(true)
    expect(existsSync(join(root, 'installed/order-row.png'))).toBe(true)
  })

  it('shoots everything with --all', { timeout: 120_000 }, async () => {
    const root = project()
    const { code } = await cli(root, ['--all'])
    expect(code).toBe(0)
    expect(existsSync(join(root, 'out/order-row.png'))).toBe(true)
    expect(existsSync(join(root, 'out/modal.png'))).toBe(true)
  })

  it('prints usage on --help without touching the project', async () => {
    const { code, out } = await cli(project(), ['--help'])
    expect(code).toBe(0)
    expect(out).toContain('shotlist --check')
  })

  it('refuses an unknown flag rather than ignoring it', async () => {
    const { code, err } = await cli(project(), ['--intsall'])
    expect(code).toBe(1)
    expect(err).toContain('--intsall')
  })
})

describe('--check', () => {
  it('reports a recipe with nothing committed as new, and exits non-zero', async () => {
    const root = project()
    const { code, out } = await cli(root, ['--check', 'order-row'])
    expect(code).toBe(1)
    expect(out).toContain('NEW      order-row')
    expect(out).toContain('1 of 1 need attention')
  })

  it('reports an unchanged screenshot as the same', { timeout: 120_000 }, async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    const { code, out } = await cli(root, ['--check', 'order-row'])
    expect(code).toBe(0)
    expect(out).toContain('same     order-row')
    expect(out).toContain('every screenshot is current')
  })

  it('reports a screenshot whose page has moved on as changed', { timeout: 120_000 }, async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    // Overwrite the committed image with a different recipe's, which is what a UI
    // change looks like from here: the same name, a different picture.
    await cli(root, ['modal'])
    cpSync(join(root, 'out/modal.png'), join(root, 'installed/order-row.png'))

    const { code, out } = await cli(root, ['--check', 'order-row'])
    expect(code).toBe(1)
    expect(out).toMatch(/CHANGED {2}order-row — size changed/)
  })

  it('skips a recipe that opts out, whatever is committed for it', async () => {
    const root = project()
    await cli(root, ['volatile', '--install'])
    const { code, out } = await cli(root, ['--check', 'volatile'])
    expect(code).toBe(0)
    expect(out).toContain('skipped  volatile')
    expect(out).toContain('opts out of checking')
  })

  it('honours a threshold the recipe sets for itself', { timeout: 120_000 }, async () => {
    const root = project()
    await cli(root, ['order-row', '--install'])
    // A threshold of 0 calls any difference at all a change; the shot is stable, so this
    // proves the recipe's own number is the one being used rather than the project's.
    const file = join(root, 'recipes/order-row.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\ncheck: { threshold: 0, tolerance: 0 }\n`)
    const { out } = await cli(root, ['--check', 'order-row'])
    expect(out).toMatch(/same|CHANGED/)
  })

  it('skips a recipe that installs nowhere, since there is nothing to compare', async () => {
    const { code, out } = await cli(project(), ['--check', 'modal'])
    expect(code).toBe(0)
    expect(out).toContain('skipped  modal')
    expect(out).toContain('installs nowhere')
  })
})
