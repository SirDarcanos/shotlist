# Building shotlist

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

There is no escape hatch. A config field for one was declared before anything used it and
removed once five real captures were written without needing it — an extension point that
exists but is never exercised is a place for the language to stop growing. If a DOM shape
genuinely cannot be expressed, that is a gap in the query language and it gets fixed here,
with the shot that needs it as the evidence.

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
6. **Every Playwright call is awaited.** ESLint enforces it, because a missed await does
   not throw: the step has not finished when the screenshot is taken, and a wrong image is
   written and installed silently.
7. **Every named function opens with a one-line JSDoc**, so editors show it on hover. No
   other comments unless the code cannot say it: a non-obvious why, a gotcha, a workaround.
8. **Everything testable has tests**, in `tests/` mirroring `src/`. The pure layers run in
   Node, the drawing layer in jsdom, the browser path against `tests/fixture/`.
9. **Every path goes through `checkPath`, every URL through `checkUrl`.** A run may be
   given a config nobody vouched for, and those two are the whole of what keeps it to the
   project and its own site. A new place that opens or writes something and calls neither
   is a hole, and nothing will fail to tell you.
10. **A control never comes from the config.** `--untrusted`, `--allow`, `--allow-path`
    and `SHOTLIST_*` are the operator's. A config may narrow what it is allowed — `deny:`
    is honoured in every mode — and may only widen it when it is trusted, which is why
    `site.allow` is ignored under `--untrusted`.

## Traps this codebase has

- **Prettier reformats between edits.** A search-and-replace written against what you last
  read will miss silently once the file has been formatted. Check that the edit landed
  rather than that the command exited.
- **Piping the gate hides it.** `npm test | grep …` reports grep's exit code, so `&&`
  carries on past a failing suite. Run the gate unpiped.
- **A one-key object with a key the query language does not know is a call to a finder.**
  That is how `{ listRow: 'Acme' }` works, and it is why `grow: { left: 4 }` was read as a
  finder named `left`. A new query key whose value is an object of non-query keys belongs
  in `NOT_A_QUERY` in `query.ts`.
- **The browser is the only encoder, and it lies about the ones it cannot do.** A canvas
  asked for a format it will not write answers with a PNG rather than an error — which is
  how an `.avif` file full of PNG bytes gets written and installed. Every conversion checks
  the mime it got back, and `FORMATS` is pinned by a test to what Chromium can really
  encode. Adding a format means proving the browser writes it, not adding a string.
- **`site.timeout` bounds a query because the page cannot be interrupted.** A `matching`
  pattern runs inside the page on its one thread; nothing else can stop it.

## Layout

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
| `tests/fixture/`  | two pages the browser-driven tests shoot — see CONTRIBUTING |

## Definition of done

All of these, not most of them.

### Green

- [ ] `npm run format` has been run, and `npm run format:check` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, including the tests you added.
- [ ] `npm run build` passes and the JSON Schemas regenerate.

### Covered

- [ ] New or changed behaviour has a test. A bug fix has a test that failed before it.
- [ ] A new query primitive has a shape in `tests/fixture/` and a test against it.
- [ ] A new step verb is in `VERBS`, which is what gives a typo of it a suggestion.
- [ ] Anything counting, indexing or measuring was checked by breaking it: change the
      implementation, watch the test fail, put it back. A test that cannot fail is not
      one, and a fixture the same length as the index under test will hide an off-by-one
      — `nth: -2` and `nth: 0` are the same element in a list of two.

### Consistent

- [ ] No second definition of any shape. Types are inferred, JSON Schemas are generated.
- [ ] Nothing site-specific entered the package (rule 1).
- [ ] `index.html`'s `data-rect` attributes still match its CSS. `site.html` has none.

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
