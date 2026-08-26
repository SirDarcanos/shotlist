# Contributing to shotlist

We welcome bug reports, broken recipes, and requests for missing vocabulary.

Use this guide to set up the repository, make changes, open a pull request, and cut a
release. Agents start at [`AGENTS.md`](./AGENTS.md), then read this workflow and any context
the task requires.

## Setup

Use Node 20 or newer.

```bash
npm install
npm i -D playwright   # browser-driven layers
```

Playwright is an optional peer dependency, so `npm install` does not pull it in. You can
test the config, recipe, macro, and query layers in Node and jsdom without a browser.

## Commands

| Command                | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `npm test`             | Run the suite once                               |
| `npm run test:watch`   | Run the suite after each save                    |
| `npm run typecheck`    | `tsc --noEmit` over `src`, `tests` and `scripts` |
| `npm run lint`         | ESLint's promise rules over `src` and `tests`    |
| `npm run format`       | Format everything with Prettier                  |
| `npm run format:check` | Fail if anything is unformatted                  |
| `npm run build`        | Compile to `dist/` and generate the JSON Schemas |

- Let Prettier format the files. Keep `tests/fixture/` hand-aligned because its `data-rect`
  attributes correspond to the CSS.
- Use ESLint to catch unawaited promises that `tsc` cannot see. An unfinished step produces
  a wrong screenshot rather than an error.
- Run `npm run build` after changing a schema. The build derives JSON Schemas from the Zod
  schemas, and editors need those generated files for autocomplete.

## Steps for contributing

1. Create an issue for the bug you want to fix or the feature you want to add.
2. Create your own fork on GitHub, check it out, and use a branch for the issue.
3. Write the code and its test.
4. Run the gate without a pipe. `npm test | grep …` reports grep's exit code, so a `&&`
   chain continues after a test failure:

   ```bash
   npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
   ```

5. After the gate passes, commit to your fork and open a pull request. Reference the issue
   by number, such as `#123`.

Keep each pull request focused on one concern. Write commit subjects as `Area: what
changed`, using an imperative verb and sentence case after the prefix. Use the body to
explain why. The MIT license applies without source-file headers.

## Working with an agent

[`AGENTS.md`](./AGENTS.md) is the canonical agent entry point. Give the agent the repository
rather than copying sections of this guide into a prompt; its context pointers load the
language, runtime, imaging, security, or test material the task needs without creating a
second source of truth.

You remain the author. Read the diff, run the gate, and explain why the change is right
before you submit it.

## What "done" means

Meet each criterion before you submit a pull request.

- [ ] Run the full gate: `format:check`, `lint`, `typecheck`, `test`, `build`.
- [ ] Test new or changed behavior. For a bug fix, add a test that fails against the old
      implementation.
- [ ] Check counting, indexing, and measurement tests by breaking the implementation,
      watching the test fail, and restoring the code. Use fixtures that expose boundary
      errors: `nth: -2` and `nth: 0` select the same element in a list of two.
- [ ] Add a shape in `tests/fixture/` and a test for each new query primitive. Add each new
      step verb to the `VERBS` array in `src/recipe.ts` so typos receive a "did you mean"
      suggestion.
- [ ] Add an entry to the correct `## [Unreleased]` section in
      [`CHANGELOG.md`](./CHANGELOG.md).
- [ ] Document recipe format, step vocabulary, and query language changes in the separate
      [shotlist.dev/docs](https://shotlist.dev/docs) repository. Keep this README brief, and
      update `skills/shotlist/` with facts an agent needs to write recipes.
- [ ] Put each documentation change in its [Diátaxis](https://diataxis.fr/) section: keys in
      `reference/`, reasons in `explanation/`, and tasks in `how-to/`. A change may require
      more than one section. Follow that repository's `AGENTS.md`.
- [ ] Document working behavior. Mark planned behavior as not built.

## The rules

1. **Keep recipes declarative.** Add a verb or query primitive when the vocabulary cannot
   describe a screenshot. Reject `eval:` and any other recipe field that runs JavaScript.
2. **Keep the package independent of sites.** Put product colors, selectors, domain terms,
   and screenshot purposes in config. Give each setting a neutral default.
3. **Define each shape once.** Define Zod schemas in `config.ts` and `recipe.ts`, infer the
   TypeScript types, and generate the JSON Schemas during the build. Do not hand-write the
   derived types or schemas.
4. **Write errors for someone editing YAML.** Name the file, the path inside it, and the
   fix. Use `unknown step "clik" — did you mean "click"?` rather than a Zod dump.
5. **Guard each path and URL.** Route each path through `checkPath` and each URL through
   `checkUrl` in `src/trust.ts`. A run may receive a config that no maintainer reviewed,
   and new callers can bypass the trust boundary without failing a test.
6. **Keep controls under operator authority.** The operator owns `--untrusted`, `--allow`,
   `--allow-path`, and `SHOTLIST_*`. A config can narrow authority through `deny:` in any
   mode. It can widen authority in trusted mode.
7. **Await each Playwright call and resolve Playwright at run time.** If you miss an await,
   shotlist captures the page before the step finishes and writes the wrong image without
   an error. Keep Playwright optional so consuming projects avoid a browser download during
   installation. If Playwright is missing, print the installation command.
8. **Keep `evaluateQuery` pure.** Playwright serializes it into the page, so it cannot use
   imports or close over module state. Test it in jsdom.
9. **Open each named function with a one-line JSDoc.** Editors show that line on hover. Add
   other comments for a non-obvious reason, gotcha, or workaround.
10. **Place tests in `tests/`, mirroring `src/`.** Run pure-layer tests in Node, drawing
    tests in jsdom, and browser tests against `tests/fixture/`.

## Where things live

| Path                | What it is                                                  |
| ------------------- | ----------------------------------------------------------- |
| `src/config.ts`     | config schema, defaults, loading, merge                     |
| `src/recipe.ts`     | recipe schema, loading, macro expansion, interpolation      |
| `src/query.ts`      | the element query language: schema, finders, page evaluator |
| `src/steps.ts`      | the step vocabulary, run against a Playwright page          |
| `src/annotate.ts`   | the drawing layer, injected into the page                   |
| `src/capture.ts`    | clip, scale, canvas growth, encode, write                   |
| `src/image.ts`      | encoded format detection and image dimensions               |
| `src/check.ts`      | pixel comparison against the committed image                |
| `src/session.ts`    | login, storage-state narrowing, verification                |
| `src/serve.ts`      | starting the site and stopping its process tree             |
| `src/trust.ts`      | what a config may reach: hosts, paths, commands, sessions   |
| `src/baseline.ts`   | what the committed images were taken with                   |
| `src/playwright.ts` | resolving the optional Playwright peer at run time          |
| `src/lint.ts`       | aggregate validation without starting a browser             |
| `src/init.ts`       | the scaffold `--init` writes                                |
| `src/schemas.ts`    | runtime schemas exported to the build generator             |
| `src/index.ts`      | the public library surface                                  |
| `src/cli.ts`        | the `shotlist` binary                                       |
| `tests/fixture/`    | neutral pages used by jsdom and browser-driven tests        |

## Adding a step verb or a query primitive

1. Start with a screenshot the current vocabulary cannot describe. Check whether an
   existing primitive solves it before adding one.
2. Add a primitive that composes with existing filters. `pick: outermost` can reach a
   modal's card when the nearest matching ancestor cannot; a `modalCard:` verb would serve
   one structure.
3. Keep site, framework, and design-system details in project finders.
4. Add a fixture shape and a matching test.

## The fixtures

Use `tests/fixture/index.html` to exercise query primitives against a list, detail pane,
controls, and modal. Browser tests shoot it, while jsdom tests query it. Each element has a
`data-rect="x,y,width,height"` attribute because jsdom lacks a layout engine and browsers
ignore the attribute. Update the attributes when you change the CSS, or jsdom will test
stale geometry.

Use `tests/fixture/site.html` for browser tests that need a product page with a brand, nav,
hero, pricing, table, and footer. Do not add `data-rect`; jsdom does not use this fixture.
Its script redraws the "last seen" column after each load so tests can exercise `mask` and
`check.ignore`.

Use `tests/fixture/signin.html` to test a sign-in form and the signed-in state. The form sets
a cookie that selects the state. Session tests serve this fixture over HTTP because a
`file:` origin cannot retain cookies.

Use `tests/fixture/framed.html` to test an iframe with an offset, border, and padding. A
rectangle measured inside the frame excludes those values. The `?src=` parameter loads
`framed-inner.html` from the same origin or another origin; frame tests start two servers
for the cross-origin case.

Use `tests/fixture/verbs.html` for controls and the step-vocabulary event log. Keeping those
controls separate prevents action tests from requiring hand-maintained jsdom geometry.

Add neutral fixture shapes rather than copying a product.

Tests use `JetBrainsMono-Bold.woff2` to load a font from disk. See
`JetBrainsMono-OFL.txt` for its SIL Open Font License 1.1. The package excludes the font
because `files` in `package.json` includes `dist`, `skills`, the README, and the license.

## Releasing

Maintainers release shotlist through GitHub Actions and npm Trusted Publishing. The job
uses no token, and npm attaches provenance.

1. Run the full gate.
2. In [`CHANGELOG.md`](./CHANGELOG.md), move the `## [Unreleased]` entries under a new
   version heading with today's date, and leave an empty `Unreleased` above it.
3. Bump and tag. npm's default commit message is a bare version number, so override it:

   ```bash
   npm version minor -m "Release: %s"
   ```

4. Push, including the tag: `git push --follow-tags`.
5. Draft a GitHub release tagged `v<version>` and publish it.

GitHub Actions stops if the tag and `package.json` disagree or `CHANGELOG.md` lacks a
heading for the release version. `prepublishOnly` runs the full gate in the publishing job.

### Breaking changes

The recipe format is public API. Renaming a step verb, removing a query key, or changing a
key's meaning breaks recipes that use it:

- Before 1.0: a **minor** bump, plus a `Changed` entry saying what to edit.
- After 1.0: a **major** bump.
- Adding a verb, primitive or config key: patch or minor.

## Reporting a bug

**A recipe that fails.** Include the recipe, the `finders` section of the config if it uses
a finder, and the error. shotlist should name the file, the path inside it, and the fix. If
the error omits one, include that omission in your report.

**A security issue.** shotlist runs configs from forked pull requests and submitted jobs.
Use GitHub's **Report a vulnerability** on the Security tab if you can bypass
`--untrusted`, evade a path or host check, or make a run touch a denied resource. The
**[security model](https://shotlist.dev/docs/explanation/security-model)** lists the known
limits.
