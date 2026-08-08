// A server behind a middleman, for testing that stopping one reaches all of it.
//
// This is the shape of every real dev command: `npm run dev` is npm, which spawns node,
// which is the thing holding the port. Signalling only the process shotlist spawned
// would leave the grandchild listening, and the next run would find it answering.
import { spawn } from 'node:child_process'

const port = Number(process.argv[2])

spawn(
  process.execPath,
  ['-e', `require('http').createServer((q, s) => s.end('ok')).listen(${port})`],
  { stdio: 'ignore' },
)

// Outlive the test without doing anything, so the middleman is still there to be killed.
setTimeout(() => {}, 60_000)
