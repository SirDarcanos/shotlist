# Contributing to shotlist

Bug reports, recipes that don't work, and missing vocabulary are all welcome.

This file covers setup, running things, and cutting a release. [`AGENTS.md`](./AGENTS.md)
covers how the code is built: the rules, the code style, the test layout, and the
definition of done. Read it before writing code. This file links to it rather than
repeating it, so the two cannot disagree.

## The rule that shapes contributions

A recipe is data. If a screenshot needs code, the vocabulary is missing a verb or a
query primitive — add that instead. Pull requests adding an `eval:` step or any other
way to run JavaScript from a recipe will not be merged.

## Setup

Node 20 or newer.

```bash
npm install
npm i -D playwright   # only needed for the browser-driven layers
```

Playwright is an optional peer dependency, so `npm install` does not pull it in. The
config, recipe, macro and query layers have no browser dependency and their tests run in
Node and jsdom.

## Commands

| Command                | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `npm test`             | Run the suite once                               |
| `npm run test:watch`   | Run the suite on every save                      |
| `npm run typecheck`    | `tsc --noEmit` over `src`, `tests` and `scripts` |
| `npm run format`       | Format everything with Prettier                  |
| `npm run format:check` | Fail if anything is unformatted                  |
| `npm run build`        | Compile to `dist/` and generate the JSON Schemas |

Prettier decides formatting. Do not hand-align code or fight it. `tests/fixture/` is
excluded: its `data-rect` attributes are aligned with the CSS by hand, and reflowing them
hides drift between the two.

Run `npm run build` after changing any schema. The JSON Schemas that drive editor
autocomplete are generated from the zod schemas, so a new field only reaches editors once
they are regenerated.

## The fixture

`tests/fixture/index.html` is a three-column app with a list, a detail pane, a controls
pane and a modal. The browser-driven tests shoot it; the jsdom tests query it.

Two constraints:

- **Every element carries `data-rect="x,y,width,height"`.** jsdom has no layout engine,
  so rects would all be zero. A real browser ignores the attribute and measures the page.
  When you change the CSS, update the attributes to match, or the jsdom tests pass
  against numbers the page no longer has.
- **Nothing in it comes from a real product.** The fixture exercises query primitives. If
  you need a new shape to test against, add a neutral one.

## Before opening a pull request

```bash
npm run format:check && npm run typecheck && npm test && npm run build
```

The full list of what "finished" means is in
[AGENTS.md → Definition of done](./AGENTS.md#definition-of-done).

One concern per pull request. Commit subjects are `Area: what changed` — imperative,
sentence case after the prefix. The body explains why.

## Adding a step verb or a query primitive

Requirements:

1. **A real screenshot that cannot be described today.** Most gaps turn out to be an
   existing primitive that was hard to find.
2. **Composable, not special-cased.** `pick: outermost` was added because climbing to the
   nearest matching ancestor could not reach a modal's card. It combines with every other
   filter. A `modalCard:` verb would not have.
3. **Not specific to one site, framework or design system.** Those belong in a project's
   own `finders` aliases.
4. **A fixture shape and a test to match.**

New verbs go in the `VERBS` array in `src/recipe.ts`. That list also powers the "did you
mean" suggestion on a typo.

## Releasing

1. `npm run format:check && npm run typecheck && npm test && npm run build` — all green.
2. In [`CHANGELOG.md`](./CHANGELOG.md), move the `## [Unreleased]` entries under a new
   version heading with today's date, and leave an empty `Unreleased` above it.
3. Bump and tag. npm's default commit message is a bare version number, so override it:

   ```bash
   npm version minor -m "Release: %s"
   ```

4. `npm publish` — `prepublishOnly` re-runs the format check, typecheck, tests and the
   build. Add
   `--otp=<code>` if the account has 2FA.
5. `git push --follow-tags`.

### Breaking changes

The recipe format is public API. Renaming a step verb, removing a query key, or changing
what a key means breaks every recipe in every project using it.

- Before 1.0: a **minor** bump, plus a `Changed` entry saying what to edit.
- After 1.0: a **major** bump.
- Adding a verb, primitive or config key: patch or minor.

## Reporting a recipe that fails

Include the recipe, the `finders` section of the config if it uses an alias, and the
error. Errors are meant to name the file, the path inside it, and the fix. If yours did
not, report that too.
