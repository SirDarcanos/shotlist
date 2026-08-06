import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The fixture page, as the URL a recipe can be pointed at. */
export const FIXTURE = pathToFileURL(join(HERE, 'fixture/index.html')).href

const made: string[] = []

/**
 * A throwaway copy of the fixture project, pointed at the fixture page.
 *
 * Shooting writes `out/` and `installed/`, so no test may run against `tests/project`
 * itself: vitest runs files in parallel, and one test's output becomes another's
 * starting state.
 */
export function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'shotlist-'))
  cpSync(join(HERE, 'project'), root, { recursive: true })
  const file = join(root, 'shotlist.config.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('url: FIXTURE', `url: ${FIXTURE}`))
  made.push(root)
  return root
}

/** Remove every project made so far. */
export function removeProjects(): void {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
}
