Read this before writing code. It is how shotlist is built, and it is the source of
truth for the rules. Setup, commands and releases are in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## What shotlist is

It takes annotated UI screenshots. It drives a running site with Playwright, clips a
region, draws callouts on it, and writes the image where the project asks.

Each screenshot is a YAML recipe. What the screenshots are for — a handbook, a landing
page, a release post, a store listing — is not the package's concern. Nothing here may
assume one of them.

## The rule everything else serves

A recipe is data. If a screenshot needs code, a step verb or a query primitive is
missing. Add that.

Do not add an `eval:` step, or any other way to run JavaScript from a recipe.

There is one exception, and it lives in the consuming project rather than here: a project
may point `finders` at its own module for a DOM shape the query language cannot express.
If that is used often, the query language is too small — fix it here.

## Rules

1. **Nothing site-specific ships in the package.** No colour that only suits a dark app,
   no selector, no domain word, no assumption about what a screenshot is for. Values like
   that are config, with a neutral default.
2. **One definition per shape.** The zod schemas in `config.ts` and `recipe.ts` are the
   source: TypeScript types are inferred from them, and the JSON Schemas are generated
   from them at build time. Do not hand-write either.
3. **Errors name the file, the path inside it, and the fix.** The person reading them is
   editing YAML, not TypeScript. `unknown step "clik" — did you mean "click"?` is the
   standard; a zod dump is not.
4. **`evaluateQuery` is pure.** No imports, no closure over anything. It is serialized
   into the page to run, and tested in jsdom.
5. **Playwright is an optional peer dependency.** Its postinstall downloads browsers, so
   consuming projects must not pay for it on every install. Resolve it at run time; when
   it is missing, print the command that installs it.
6. **Every named function opens with a one-line JSDoc**, so editors show it on hover. No
   other comments unless the code cannot say it: a non-obvious why, a gotcha, a workaround.
7. **Everything testable has tests**, in `tests/` mirroring `src/`. The pure layers run in
   Node, the drawing layer in jsdom, the browser path against `tests/fixture/`.

## Layout

| Path              | What it is                                                  |
| ----------------- | ----------------------------------------------------------- |
| `src/config.ts`   | config schema, defaults, loading, merge                     |
| `src/recipe.ts`   | recipe schema, loading, macro expansion, interpolation      |
| `src/query.ts`    | the element query language: schema, aliases, page evaluator |
| `src/steps.ts`    | the step vocabulary, run against a Playwright page          |
| `src/annotate.ts` | the drawing layer, injected into the page                   |
| `src/capture.ts`  | clip, scale, canvas growth, write                           |
| `src/check.ts`    | perceptual diff against the committed image                 |
| `src/cli.ts`      | the `shotlist` binary                                       |
| `tests/fixture/`  | the static site the browser-driven tests shoot              |

## Definition of done

All of these, not most of them.

### Green

- [ ] `npm run format` has been run, and `npm run format:check` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, including the tests you added.
- [ ] `npm run build` passes and the JSON Schemas regenerate.

### Covered

- [ ] New or changed behaviour has a test. A bug fix has a test that failed before it.
- [ ] A new query primitive has a shape in `tests/fixture/` and a test against it.
- [ ] A new step verb is in `VERBS`, which is what gives a typo of it a suggestion.

### Consistent

- [ ] No second definition of any shape. Types are inferred, JSON Schemas are generated.
- [ ] Nothing site-specific entered the package (rule 1).
- [ ] The fixture's `data-rect` attributes still match its CSS.

### Documented

- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`, in the right section.
- [ ] A change to the recipe format, the step vocabulary or the query language is in the
      README's reference tables. The README is reference: what a key does, in plain
      language, and nothing else.
- [ ] Every named function has its one-line JSDoc.

### Honest

- [ ] Errors a recipe author can hit name the file, the path inside it, and the fix.
- [ ] Nothing is documented that does not work yet, unless it is marked as not built.

## Committing

- One concern per commit. Subject `Area: what changed`, imperative, sentence case after
  the prefix. The body explains why.
- MIT. No license headers in source files; the LICENSE file is the whole of it.
