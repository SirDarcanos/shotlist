# Runtime lifecycle

`src/cli.ts` owns resources shared by a command. `src/capture.ts:shoot` owns one recipe,
while `src/steps.ts` owns ordered browser interaction. Put behavior at the lowest owner
that can enforce it, because CLI-only fixes do not protect library callers.

## Project run

The CLI loads the config and library, selects recipes, and starts the configured site only
when at least one selected recipe has `source: app`. It launches one Chromium browser for
a capture or check batch and closes it in `finally`; selected recipes run sequentially.

Playwright remains an optional peer. `loadPlaywright` resolves `playwright`, then
`playwright-core`, then installations under the npm `npx` cache. Preserve the actionable
installation error because non-browser commands must work without forcing Playwright's
browser download on every consumer.

## Capture attempt

An application recipe performs one complete attempt in a fresh browser context:

1. Resolve recipe settings and enforce pixel, trust, and session bounds.
2. Navigate the main page and wait for readiness, session verification, and settling.
3. Expand and run setup steps serially.
4. Resolve clip, marks, masks, and ignore regions, then capture a lossless PNG.
5. Run teardown in `finally` and close the attempt's context.
6. Annotate and encode in separate pages, then write output and optional install copies.

A retry repeats the whole attempt in a fresh context rather than inheriting cookies, pages,
or failed UI state. Teardown runs after success and failure. If capture already failed, a
teardown failure does not replace the error that explains the missing screenshot.

A file recipe validates and reads its image before browser work. It has no application page,
so setup and teardown are invalid and every mark or mask must resolve without a DOM.

## Steps and pages

`runSteps` awaits every `runStep` in source order. Keep every Playwright call awaited,
because unfinished interaction produces a wrong screenshot rather than an exception; the
promise-only ESLint rules exist for this failure mode.

`wait` either sleeps for a duration or polls the custom query language every 100 ms until
`site.timeout`. Preserve the last query error on timeout so an absent candidate remains
distinguishable from malformed or impossible geometry.

`openPage` creates a named page and `usePage` changes the current one. Dialog policy is
standing state: each page gets one listener that reads the current policy when a dialog
arrives. Every step ensures newly opened or selected pages have that listener.

`optional` deliberately swallows any nested failure. Keep it broad only for transient UI
whose absence is acceptable, because it trades diagnosis for optionality.

## Site ownership

`startServer` returns `null` when no command is configured or the target URL already
answers. Commands run directly with `shell: false`; environment belongs in `serve.env` and
shell composition belongs in a project script.

A server shotlist starts runs in its own process group and is stopped by `withServer`. An
existing server is never stopped. Shutdown is idempotent, sends `SIGTERM`, and escalates to
`SIGKILL` after five seconds so child processes cannot outlive the command.

Readiness may be an HTTP(S) URL, a TCP port, or an output pattern. Retain the last 40 output
lines and race readiness against child exit, because an early crash or missing executable
is the useful error rather than a generic timeout.

## Session ownership

A recipe names a configured session; `src/session.ts` resolves it relative to the config
root, narrows it to approved hosts, and loads it into the attempt context. A configured
verification selector distinguishes an authenticated page from a silent redirect to sign
in.

Login writes narrowed storage state only after optional verification in a fresh context.
Session files use mode `0600`, including files that already existed, because they contain
credentials rather than ordinary project data.
