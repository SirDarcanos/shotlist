import { constants, copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { authorizePath } from './trust.js'
import type { Run } from './run.js'

/** Replace one authorized file through a complete temporary sibling. */
function replaceFile(
  run: Run,
  destination: string,
  where: string,
  writeTemporary: (temporary: string) => void,
): void {
  const target = authorizePath(run.trust, destination, where)
  mkdirSync(dirname(target), { recursive: true })
  const temporaryName = `.${basename(target)}.${randomUUID()}.tmp`
  const temporary = authorizePath(
    run.trust,
    join(dirname(target), temporaryName),
    `${where} temporary file`,
  )
  try {
    writeTemporary(temporary)
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Replace an authorized destination with one complete authorized source file. */
export function replaceFileFrom(
  run: Run,
  source: string,
  destination: string,
  where: string,
): void {
  const sourceTarget = authorizePath(run.trust, source, `${where} source`)
  replaceFile(run, destination, where, (temporary) =>
    copyFileSync(sourceTarget, temporary, constants.COPYFILE_EXCL),
  )
}

/** Replace an authorized destination with complete in-memory contents. */
export function replaceFileWith(
  run: Run,
  destination: string,
  contents: string | NodeJS.ArrayBufferView,
  where: string,
): void {
  replaceFile(run, destination, where, (temporary) =>
    writeFileSync(temporary, contents, { flag: 'wx' }),
  )
}
