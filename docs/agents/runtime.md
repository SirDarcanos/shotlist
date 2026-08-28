# Runtime lifecycle

`src/execute.ts` owns site and browser lifetimes shared by the selected Recipes in a Run.
`src/cli.ts` owns argument parsing and rendering, `src/capture.ts:shoot` owns one Recipe,
and `src/step.ts` owns the built-in Step vocabulary from authored shape through ordered
browser interaction. `src/steps.ts` authenticates the Run at the execution facade. Put
behavior at the lowest owner that can enforce it, because CLI-only fixes do not protect
library callers.

## Project run

The CLI loads the config and Library, then Run execution coordinates the selected Recipes.
TypeScript callers use `Run.capture` and `Run.check` with either a non-empty ordered
Recipe-name list or `all: true`; selection is complete before effects, and one Run refuses
overlap until its request and resource cleanup settle. Capture starts the configured site
only when at least one selected Recipe has `source: app`.
Checking first removes Recipes that opt out or install nowhere, then starts the site only
when an actionable Application Recipe remains. A Run of only skipped Recipes starts neither
the site nor Chromium. Run execution launches one Chromium browser for the remaining
Capture or Checking work, closes it before returning, and keeps Recipes sequential. Both
reports account for every selected Recipe and retain request-level startup and cleanup
failures separately from Recipe results. Checking reports keep completed findings,
environment drift, Ignore-region counts, and optional diff-image paths.

`src/library.ts` owns policy-aware Library discovery, reading, parsing, and publication.
Run opening asks it for one complete immutable Library; lint asks it for one review that
keeps every reachable problem and the matching document count. Both authorize every
configured directory before enumerating one and every discovered document before reading
one.

Playwright remains an optional peer. `loadPlaywright` resolves `playwright`, then
`playwright-core`, then installations under the npm `npx` cache. Preserve the actionable
installation error because non-browser commands must work without forcing Playwright's
browser download on every consumer.

## Capture attempt

An application recipe performs one complete attempt in a fresh browser context:

1. Resolve recipe settings and enforce pixel, trust, and session bounds.
2. Attach Network destination enforcement before creating the page, then navigate and wait for readiness, Session verification, and settling.
3. Expand and run setup Steps serially.
4. Resolve Clip, Marks, Masks, and Ignore regions, fail on blocked requests, then capture a lossless PNG.
5. Run teardown in `finally` and close the attempt's context.
6. Annotate and encode in separate pages, then write output and optional install copies.

A retry repeats the whole attempt in a fresh context rather than inheriting cookies, pages,
or failed UI state. Every retry gets a fresh actual-Step Work limit, while the Recipe and
all retries share one elapsed Work limit. A Work-limit failure is deterministic and is not
retried. Teardown runs after success and failure under its reserved Step count and cleanup
minute. If capture already failed, a teardown failure does not replace the error that
explains the missing screenshot.

A file recipe validates and reads its image before browser work. It has no application page,
so setup and teardown are invalid and every mark or mask must resolve without a DOM.

## Steps and pages

`runSteps` awaits every `runStep` in source order and charges each actual Step to the
current attempt or teardown meter. `each` checks its interpolated list before the first item
runs. Keep every Playwright call awaited,
because unfinished interaction produces a wrong screenshot rather than an exception; the
promise-only ESLint rules exist for this failure mode.

`wait` either sleeps for a duration or polls the custom query language every 100 ms until
`site.timeout`. Preserve the last query error on timeout so an absent candidate remains
distinguishable from malformed or impossible geometry.

`openPage` creates a named page and `usePage` changes the current one. Dialog policy is
standing state: each page gets one listener that reads the current policy when a dialog
arrives. Every step ensures newly opened or selected pages have that listener.

`optional` swallows ordinary nested failures for transient UI whose absence is acceptable. It rethrows Network policy failures because Operator authority cannot become optional Recipe behavior.

## Site ownership

`startServer` returns `null` when no command is configured or the target URL already
answers. Commands run directly with `shell: false`; environment belongs in `serve.env` and
shell composition belongs in a project script.

A server shotlist starts runs in its own process group and is stopped by `withServer`. An
existing server is never stopped. Shutdown is idempotent, sends `SIGTERM`, and escalates to
`SIGKILL` after five seconds so child processes cannot outlive the command.

Readiness may be an HTTP(S) URL, a TCP port, or an output pattern. Authorize the command before probing, check every HTTP redirect manually, and check a numeric port as exact TCP access to `127.0.0.1`. Retain the last 40 output lines and race readiness against child exit, because an early crash or missing executable is the useful error rather than a generic timeout.

## Session ownership

A Recipe names a configured Session; `src/session.ts` resolves it relative to the config root, narrows it to the site host and explicit `keep` hosts, and loads it into the attempt context. Network destination approvals do not retain credentials, and `keep` does not grant network access. A configured verification Query distinguishes an authenticated page from a silent redirect to sign in.

Login writes narrowed storage state only after optional verification in a fresh context.
Session files use mode `0600`, including files that already existed, because they contain
credentials rather than ordinary project data.
