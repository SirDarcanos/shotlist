# Contributing to shotlist

Bug reports, recipes that don't work, and missing vocabulary are all welcome.

Everything you need is in this file: setup, the commands, the code style, what "done"
means, and how a release is cut. You should not have to read anything else to open a good
pull request. [`AGENTS.md`](./AGENTS.md) has the reasoning behind the rules and the traps
this codebase has — worth a read once you are deeper in, but not a prerequisite.

## Setup

Node 20 or newer.

```bash
npm install
npm i -D playwright   # only for the browser-driven layers
```

Playwright is an optional peer dependency, so `npm install` does not pull it in. The
config, recipe, macro and query layers have no browser dependency, and their tests run in
Node and jsdom.

## Commands

| Command                | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `npm test`             | Run the suite once                               |
| `npm run test:watch`   | Run the suite on every save                      |
| `npm run typecheck`    | `tsc --noEmit` over `src`, `tests` and `scripts` |
| `npm run lint`         | ESLint's promise rules over `src` and `tests`    |
| `npm run format`       | Format everything with Prettier                  |
| `npm run format:check` | Fail if anything is unformatted                  |
| `npm run build`        | Compile to `dist/` and generate the JSON Schemas |

- Prettier decides formatting. Do not hand-align code or fight it. `tests/fixture/` is
  excluded: its `data-rect` attributes are aligned with the CSS by hand.
- ESLint runs three rules about unawaited promises and nothing else. `tsc` cannot see
  those, and a step that has not finished produces a wrong screenshot rather than an error.
- Run `npm run build` after changing any schema. The JSON Schemas that drive editor
  autocomplete are generated from the zod ones, so a new field only reaches editors once
  they are regenerated.

## Steps for contributing

1. Create an issue for the bug you want to fix or the feature you want to add.
2. Create your own fork on GitHub, then check out your fork. A branch per issue is good
   practice, though not mandatory.
3. Write your code, and a test for it.
4. Run the gate. Run it unpiped — `npm test | grep …` reports grep's exit code, so a `&&`
   chain carries on past a suite that failed:

   ```bash
   npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
   ```

5. If everything is green, commit to your fork and open a pull request from there. Make
   sure to reference your issue by number, e.g. `#123`.

One concern per pull request. Commit subjects are `Area: what changed` — imperative,
sentence case after the prefix. The body explains why. The project is MIT; the LICENSE
file is the whole of it, so source files carry no license headers.

## Contributing with AI

AI-assisted fixes are very welcome, and no pull request will be judged on how it was
written. Two things make the difference between one that lands and one that wastes
everybody's time:

- **Have it read the codebase first**, along with the Markdown files, and the website at [shotlist.dev](https://shotlist.dev): this one,
  [`README.md`](./README.md) for what every key does, and [`AGENTS.md`](./AGENTS.md) for
  the rules and the traps. Most rejected patches are a second definition of a shape that
  already exists, or a verb that duplicates a primitive the model did not know about.
- **You are the author.** Read the diff, run the gate yourself, and be ready to explain
  why the change is right. A patch nobody has read is not ready, whoever typed it.

## What "done" means

All of these, not most of them.

- [ ] The gate is green: `format:check`, `lint`, `typecheck`, `test`, `build`.
- [ ] New or changed behavior has a test. A bug fix has a test that failed before it.
- [ ] Anything counting, indexing or measuring was checked by breaking it: change the
      implementation, watch the test fail, put it back. A test that cannot fail is not one,
      and a fixture the same length as the index under test hides an off-by-one — `nth: -2`
      and `nth: 0` are the same element in a list of two.
- [ ] A new query primitive has a shape in `tests/fixture/` and a test against it. A new
      step verb is in the `VERBS` array in `src/recipe.ts`, which is what gives a typo of
      it a "did you mean" suggestion.
- [ ] [`CHANGELOG.md`](./CHANGELOG.md) has an entry under `## [Unreleased]`, in the right
      section.
- [ ] A change to the recipe format, the step vocabulary or the query language is in the
      reference at [shotlist.dev/docs](https://shotlist.dev/docs), which lives in its own
      repository. The README is the short version and links there; `skills/shotlist/` ships
      with the package and needs anything an agent writing recipes would have to know.
- [ ] The change went into the right part of those docs. They follow
      [Diátaxis](https://diataxis.fr/), so a new key is a row in `reference/`, the reason
      behind it belongs in `explanation/`, and the task it makes possible is a page in
      `how-to/`. One change often touches more than one, and those are not duplicates of
      each other. See that repository's `AGENTS.md`.
- [ ] Nothing is documented that does not work yet, unless it is marked as not built.

## The rules

1. **A recipe is data.** If a screenshot needs code, the vocabulary is missing a verb or a
   query primitive — add that instead. Do not add an `eval:` step, or any other way to run
   JavaScript from a recipe. Pull requests that do will not be merged.
2. **Nothing site-specific ships in the package.** No color that only suits a dark app, no
   selector, no domain word, no assumption about what a screenshot is for. Values like that
   are config, with a neutral default.
3. **One definition per shape.** The zod schemas in `config.ts` and `recipe.ts` are the
   source: TypeScript types are inferred from them, and the JSON Schemas are generated from
   them at build time. Do not hand-write either.
4. **Errors name the file, the path inside it, and the fix.** The person reading them is
   editing YAML, not TypeScript. `unknown step "clik" — did you mean "click"?` is the
   standard; a zod dump is not.
5. **Every path goes through `checkPath`, every URL through `checkUrl`**, both in
   `src/trust.ts`. A run may be given a config nobody vouched for, and those two are the
   whole of what keeps it to the project and its own site. A new caller that skips them
   fails no test.
6. **A control never comes from the config.** `--untrusted`, `--allow`, `--allow-path` and
   `SHOTLIST_*` are the operator's. A config may narrow what it is allowed — `deny:` is
   honored in every mode — and may only widen it when it is trusted.
7. **Every Playwright call is awaited**, and Playwright itself is resolved at run time. A
   missed await does not throw: the step has not finished when the screenshot is taken, and
   a wrong image is written silently. Consuming projects must not pay for the browser
   download on every install, so when Playwright is missing, print the command that
   installs it.
8. **`evaluateQuery` is pure.** No imports, no closure over anything. It is serialized into
   the page to run, and tested in jsdom.
9. **Every named function opens with a one-line JSDoc**, so editors show it on hover. No
   other comments unless the code cannot say it: a non-obvious why, a gotcha, a workaround.
10. **Tests live in `tests/`, mirroring `src/`.** The pure layers run in Node, the drawing
    layer in jsdom, the browser path against `tests/fixture/`.

## Where things live

| Path              | What it is                                                  |
| ----------------- | ----------------------------------------------------------- |
| `src/config.ts`   | config schema, defaults, loading, merge                     |
| `src/recipe.ts`   | recipe schema, loading, macro expansion, interpolation      |
| `src/query.ts`    | the element query language: schema, aliases, page evaluator |
| `src/steps.ts`    | the step vocabulary, run against a Playwright page          |
| `src/annotate.ts` | the drawing layer, injected into the page                   |
| `src/capture.ts`  | clip, scale, canvas growth, write                           |
| `src/image.ts`    | the formats a shot is written in, and reading one back      |
| `src/check.ts`    | perceptual diff against the committed image                 |
| `src/serve.ts`    | starting the site and stopping it again                     |
| `src/trust.ts`    | what a config may reach: hosts, paths, forbidden names      |
| `src/baseline.ts` | what the committed images were taken with                   |
| `src/init.ts`     | the scaffold `--init` writes                                |
| `src/cli.ts`      | the `shotlist` binary                                       |
| `tests/fixture/`  | the two pages the browser-driven tests shoot                |

## Adding a step verb or a query primitive

1. **A real screenshot that cannot be described today.** Most gaps turn out to be an
   existing primitive that was hard to find.
2. **Composable, not special-cased.** `pick: outermost` was added because climbing to the
   nearest matching ancestor could not reach a modal's card. It combines with every other
   filter. A `modalCard:` verb would not have.
3. **Not specific to one site, framework or design system.** Those belong in a project's
   own `finders` aliases.
4. **A fixture shape and a test to match.**

## The fixtures

`tests/fixture/index.html` is a three-column app — list, detail pane, controls, modal —
that exists to exercise query primitives. The browser-driven tests shoot it; the jsdom
tests query it. Every element carries `data-rect="x,y,width,height"`, because jsdom has no
layout engine and a real browser ignores the attribute. Change that file's CSS and you
update the attributes too, or the jsdom tests pass against numbers the page no longer has.

`tests/fixture/site.html` is a product page — brand, nav, hero, pricing, table, footer —
for tests that need a page shaped like the ones recipes are really written against. It is
only ever shot in a real browser, so it carries no `data-rect` and must not grow any. Its
"last seen" column is redrawn on every load on purpose: it is what `mask` and
`check.ignore` are tested against.

`tests/fixture/signin.html` has two states — a sign-in form, and what somebody signed in
sees — chosen by a cookie the form sets itself. It is the only fixture served over http
rather than opened from disk, because a `file:` origin keeps no cookies and a session is
cookies. The session tests start a server for it themselves.

`tests/fixture/framed.html` holds an iframe, offset from the page and given a border and
padding — the two things a rect measured inside a frame does not know about. Its `?src=`
decides where the frame loads from, so one file covers a same-origin frame and a
cross-origin one; the frame tests start two servers to make the second real.

Nothing in any of them comes from a real product. If you need a new shape to test against,
add a neutral one.

`JetBrainsMono-Bold.woff2` beside them is for the tests that load a font from disk. It is
SIL Open Font License 1.1, `JetBrainsMono-OFL.txt` is the license, and it is not
published — `files` in `package.json` ships only `dist`, `skills`, the README and the
license.

## Releasing

Maintainers only. Publishing runs from GitHub Actions through npm Trusted Publishing —
there is no token, and provenance is attached automatically.

1. Run the gate — all green.
2. In [`CHANGELOG.md`](./CHANGELOG.md), move the `## [Unreleased]` entries under a new
   version heading with today's date, and leave an empty `Unreleased` above it.
3. Bump and tag. npm's default commit message is a bare version number, so override it:

   ```bash
   npm version minor -m "Release: %s"
   ```

4. Push, including the tag: `git push --follow-tags`.
5. Draft a GitHub release tagged `v<version>` and publish it.

The workflow refuses to run if the tag and `package.json` disagree, or if `CHANGELOG.md`
has no heading for the version being released — step 2 is easy to skip, and a release
whose notes still say "unreleased" is the result. `prepublishOnly` re-runs the whole gate
inside that job, so a release cannot ship what a pull request could not merge.

### Breaking changes

The recipe format is public API. Renaming a step verb, removing a query key, or changing
what a key means breaks every recipe in every project using it:

- Before 1.0: a **minor** bump, plus a `Changed` entry saying what to edit.
- After 1.0: a **major** bump.
- Adding a verb, primitive or config key: patch or minor.

## Reporting a bug

**A recipe that fails.** Include the recipe, the `finders` section of the config if it uses
an alias, and the error. Errors are meant to name the file, the path inside it, and the
fix. If yours did not, report that too.

**Something security-shaped.** shotlist runs other people's configs — in CI on a fork's
pull request, or in a service shooting what somebody submitted. A way past `--untrusted`,
a path or host check that can be walked around, or anything that gets a run to touch what
it should not, is worth reporting privately first: use GitHub's **Report a vulnerability**
on the Security tab rather than opening an issue. What is already known and deliberate,
including the two things the checks do not cover, is at
**[shotlist.dev/docs/explanation/security-model](https://shotlist.dev/docs/explanation/security-model)**.
