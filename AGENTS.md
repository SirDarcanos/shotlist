Guidance for AI agents (and humans) working on shotlist. Read this before writing code.

## What shotlist is

It takes annotated UI screenshots. It drives a running site with Playwright, clips a
region, draws callouts on it, and writes the result where the project asks for it — all
from **declarative recipes**, so re-shooting a stale screenshot is a command rather than
an afternoon.

What those screenshots are *for* is none of the package's business: a handbook, a landing
page, a release post, a store listing. Nothing here may assume one of them.

## The one principle

> **A recipe is data. If a shot needs code, the vocabulary is short — not the recipe.**

Every temptation to add an `eval:` step or an inline JavaScript escape hatch is a
signal that a step verb or a query primitive is missing. Add the primitive. The whole
value of this package is that a person editing a screenshot never opens a `.ts` file.

The one sanctioned exception lives in the **consumer's** repo, not here: a project may
point `finders` at its own module for a DOM shape the query language genuinely cannot
express. If that gets used often, the query language is short and that is a bug here.

## Rules

1. **Nothing about any one site belongs in this package.** No default colors that only
   suit a dark app, no selectors, no domain words. Every such value is config with a
   neutral default.
2. **One definition per concept.** The zod schemas in `config.ts` and `recipe.ts` are
   the single source of truth: TypeScript types are inferred from them, and the JSON
   Schema that gives editors autocomplete is generated from them at build time. Never
   hand-maintain a second copy of a shape.
3. **Errors name the file, the line, and the fix.** A recipe author is the user of this
   package. `unknown step "clik" — did you mean "click"?` is the standard; a zod dump
   is not.
4. **The query language is pure.** `evaluateQuery` runs inside the page with no imports
   and no closure over anything. That is what lets it be serialized to the browser and
   unit-tested in jsdom in the same breath.
5. **Playwright is an optional peer dependency.** Its postinstall downloads browsers;
   a consuming project should not pay that on every CI install. Resolve it at run time and fail
   with the command that fixes it.
6. **Every named function, method and hook opens with a one-line header comment.** A
   one-line JSDoc, so editors surface it on hover. No other comments unless the code
   genuinely cannot say it: a non-obvious *why*, a gotcha, a workaround. Never narration
   of the next line, never self-congratulation.
7. **Everything testable ships with tests**, in `tests/` mirroring `src/`. The pure
   layers (config, recipes, macros, queries) test in node; the drawing layer tests in
   jsdom; the browser path tests against `tests/fixture/`, which is a real static site
   built to exercise every query primitive.

## Layout

| Path                | What it is                                                  |
| ------------------- | ----------------------------------------------------------- |
| `src/config.ts`     | config schema, defaults, loading, merge                     |
| `src/recipe.ts`     | recipe schema, loading, macro expansion, interpolation      |
| `src/query.ts`      | the element query language: schema, aliases, page evaluator |
| `src/steps.ts`      | the step vocabulary, run against a Playwright page          |
| `src/annotate.ts`   | the drawing layer, injected into the page                   |
| `src/capture.ts`    | clip, scale, canvas growth, write                           |
| `src/check.ts`      | perceptual diff against the committed image                 |
| `src/cli.ts`        | the `shotlist` binary                                       |
| `tests/fixture/`    | the static site the browser-driven tests shoot              |

## Definition of done

A change is finished when all of these are true. Not "mostly" — all of them.

**Green**

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, including the tests you added.
- [ ] `npm run build` passes and the JSON Schemas regenerate without error.

**Covered**

- [ ] New or changed behaviour has a test. A bug fix has a test that failed before it.
- [ ] A new query primitive has a shape in `tests/fixture/` and a test that matches it.
- [ ] A new step verb is in `VERBS`, so a typo of it gets a "did you mean".

**Consistent**

- [ ] No second definition of any shape: types are inferred from the zod schemas, and
      the JSON Schemas are generated from them. If you hand-wrote either, undo it.
- [ ] Nothing site-specific entered the package — no default that suits one product, no
      selector, no domain word, and no assumption about what the screenshots are for.
- [ ] The fixture's `data-rect` attributes still match its CSS.

**Documented**

- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`, in the right section.
- [ ] A change to the recipe format, the step vocabulary or the query language is in the
      README's reference tables. The README is reference, not narrative: state what a
      thing does in plain language and move on.
- [ ] Every named function has its one-line header comment.

**Honest**

- [ ] Errors a recipe author can hit name the file, the path inside it, and the fix.
- [ ] Nothing is documented that does not work yet, unless it is marked as not built.

## Committing

- **One concern per commit.** Subject `Area: what changed`, imperative, sentence case.
- MIT, and no license headers in source files — the LICENSE file is the whole of it.
