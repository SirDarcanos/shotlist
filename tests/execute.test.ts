import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeCheckRun } from '../src/execute.js'
import { openRun } from '../src/index.js'
import { removeProjects, tempProject } from './tempProject.js'

afterEach(removeProjects)

/** Make any attempt to start the configured site fail visibly. */
function refuseSiteStartup(root: string): string {
  const config = join(root, 'shotlist.config.yaml')
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace(
      'site:\n',
      'site:\n  serve:\n    command: shotlist-command-that-does-not-exist\n',
    ),
  )
  return config
}

describe('Run execution', () => {
  it('returns skipped checking facts without starting resources', async () => {
    const root = tempProject()
    const run = openRun({ untrusted: false }, refuseSiteStartup(root))
    const recipe = run.project.library.recipes.get('volatile')!

    const result = await executeCheckRun(run, [recipe])

    expect(result).toEqual({
      drift: [],
      operatorDestinations: [],
      results: [
        {
          name: 'volatile',
          status: 'skipped',
          reason: 'the recipe opts out of checking',
        },
      ],
    })
  })
})
