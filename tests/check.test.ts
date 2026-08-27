import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { check, loadPlaywright, openRun, shoot } from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

afterAll(removeProjects)

describe('check', () => {
  it('refuses a Recipe selected from another Run', async () => {
    const first = openRun({ untrusted: false }, join(tempProject(), 'shotlist.config.yaml'))
    const second = openRun({ untrusted: false }, join(tempProject(), 'shotlist.config.yaml'))
    const recipe = second.project.library.recipes.get('order-row')!

    await expect(check(first, [recipe])).rejects.toThrow(/does not belong to this Run/)
  })

  it('refuses a committed image outside an untrusted Run before re-shooting', async () => {
    const root = tempProject()
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-check-outside-'))
    symlinkSync(outside, join(root, 'installed'))
    const run = openRun({ untrusted: true }, join(root, 'shotlist.config.yaml'))
    const recipe = run.project.library.recipes.get('order-row')!
    const browser = await loadPlaywright().chromium.launch()
    try {
      await expect(check(run, [recipe], { browser })).rejects.toThrow(
        /committed image: .*outside the project/,
      )
      expect(existsSync(join(root, 'out/order-row.png'))).toBe(false)
    } finally {
      await browser.close()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a diff destination outside an untrusted Run', async () => {
    const root = tempProject()
    const browser = await loadPlaywright().chromium.launch()
    const outside = mkdtempSync(join(tmpdir(), 'shotlist-diff-outside-'))
    try {
      const trusted = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
      const original = trusted.project.library.recipes.get('order-row')!
      await shoot(trusted, original, { browser, install: true })
      copyFileSync(join(root, 'installed/order-row.png'), join(root, 'installed/filecheck.png'))
      writeFileSync(
        join(root, 'recipes/filecheck.yaml'),
        'name: filecheck\nsource: file\nfile: installed/order-row.png\n' +
          'install: guide\nmask: [{ rect: [0, 0, 40, 40] }]\n',
      )
      mkdirSync(join(root, 'out'), { recursive: true })
      symlinkSync(outside, join(root, 'out/diff'))
      const run = openRun({ untrusted: true }, join(root, 'shotlist.config.yaml'))
      const recipe = run.project.library.recipes.get('filecheck')!

      await expect(
        check(run, [recipe], { browser, diffDir: join(root, 'out/diff') }),
      ).rejects.toThrow(/check diff directory: .*outside the project/)
      expect(existsSync(join(outside, 'filecheck.png'))).toBe(false)
    } finally {
      await browser.close()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it(
    'compares a Run-owned Recipe, closes its context, and leaves the caller browser open',
    { timeout: 120_000 },
    async () => {
      const root = tempProject()
      const run = openRun({ untrusted: false }, join(root, 'shotlist.config.yaml'))
      const recipe = run.project.library.recipes.get('order-row')!
      const browser = await loadPlaywright().chromium.launch()
      try {
        await shoot(run, recipe, { browser, install: true })

        const [result] = await check(run, [recipe], { browser })

        expect(result).toMatchObject({ name: 'order-row', status: 'same', ratio: 0 })
        expect(existsSync(result!.shot!)).toBe(true)
        expect((browser as unknown as { contexts(): unknown[] }).contexts()).toHaveLength(0)
        const context = await browser.newContext()
        await context.close()
      } finally {
        await browser.close()
      }
    },
  )
})
