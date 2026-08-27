import { assertRun } from './run.js'
import { executeSteps } from './step.js'
import type { ResolvedStep } from './step.js'
import type { Run } from './run.js'
import type { RunContext } from './step.js'

export { resolve } from './step.js'
export type { DialogPolicy, RunContext } from './step.js'

/** Run one Recipe's expanded Steps against the page in source order. */
export async function runSteps(
  run: Run,
  steps: readonly ResolvedStep[],
  ctx: RunContext,
  scope: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  assertRun(run)
  await executeSteps(run, steps, ctx, scope)
}
