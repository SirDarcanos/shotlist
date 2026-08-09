# Building shotlist

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first, and treat it as the source of truth.
Setup, the commands, the rules, where things live, and what "done" means are all there —
written for people, and they apply to you unchanged.

This file is what does not belong in a contributor's guide: what shotlist is for, why the
recipe format is closed, how everything here is written, and the traps this codebase has.

## What shotlist is

It takes annotated UI screenshots. It drives a running site with Playwright, clips a
region, draws callouts on it, and writes the image where the project asks.

Each screenshot is a YAML recipe. What the screenshots are for — a handbook, a landing
page, a release post, a store listing — is not the package's concern. Nothing here may
assume one of them.

## Why a recipe is data

There is no escape hatch, and adding one is not a judgment call you get to make. A config
field for an `eval:`-shaped extension point was declared before anything used it, and
removed once five real captures were written without needing it — an extension point that
exists but is never exercised is a place for the language to stop growing.

So: if a DOM shape genuinely cannot be expressed, that is a gap in the query language, and
it gets fixed here with the shot that needs it as the evidence. Reaching for JavaScript
instead is the one contribution that will not be merged.

## Voice

Everything written here — comments, errors, docs, commit bodies, pull request
descriptions — sounds like one person who knows the codebase explaining it to another. Not
a tutorial, not marketing, not a changelog robot. Match what is already in the file you are
editing; when in doubt, `src/capture.ts` and this file are the reference.

**State things. Do not hedge, and do not soften.** A rule is written in the present
indicative, as a fact about the codebase, not as advice.

- Yes: `Errors name the file, the path inside it, and the fix.`
- No: `Errors should generally try to name the file where possible.`

**Every claim carries its reason, in the same breath.** A rule without its "because" gets
argued with, or followed in the wrong place. This is the single most important habit here.

- Yes: `Run the gate unpiped — npm test | grep … reports grep's exit code.`
- No: `Always run the gate unpiped. This is important.`

**Draw the contrast with "rather than".** The reason something matters is usually the thing
that happens instead, and naming it is what makes the danger legible.

- Yes: `a step that has not finished produces a wrong screenshot rather than an error`
- No: `unawaited steps can cause issues`

**Be concrete.** Name the actual key, file, value or flag. `nth: -2 and nth: 0 are the same
element in a list of two` teaches; "be careful with negative indices" does not.

**No filler.** Cut `simply`, `just`, `easy`, `obviously`, `of course`, `note that`, `please
note`, `in order to`, `it is important to`. Cut `powerful`, `robust`, `seamless`,
`comprehensive` and every other adjective that praises the software. No emoji, no
exclamation marks, no rhetorical questions.

**Length is set by content, never by shape.** There is no minimum. A one-line JSDoc is
complete if the function is. A comment may run eight lines when it is carrying a real
reason — see the webfont note in `src/capture.ts`, which is long because the failure it
describes is genuinely surprising. The sin is not length, it is a sentence that adds
nothing: a comment restating the code, a paragraph of preamble before the point, a summary
that repeats what the diff already shows.

### Comments

The rule is rule 9 in [`CONTRIBUTING.md`](./CONTRIBUTING.md#the-rules). This is what it
sounds like.

- **JSDoc is one line, and describes the thing, not the mechanics.** A noun phrase for
  values and types, an imperative for functions. This codebase uses no `@param` or
  `@returns` anywhere; the types say that already.

  ```ts
  /** Where the record lives for a given project. */ // yes
  /** Gets the path. @param loaded the config @returns str */ // no
  ```

- **A `//` comment exists only where the code cannot speak for itself**: a non-obvious why,
  a gotcha, a workaround, an assumption that will bite. Write the reason and the
  consequence, not a paraphrase of the next line.
- **Never leave a comment that narrates a change** — `// added for the new format`,
  `// changed from map to filter`. The commit message is where that lives, and the comment
  is stale the moment it lands.

### Errors

A recipe author reads these while editing YAML, and they are the whole interface at that
moment. The shape is `where: what — why or fix`.

- Lowercase first word, no trailing full stop.
- Prefixed with the path inside the file that caused it: `site.serve: …`,
  `recipe "order-row": marks.amount — …`.
- Name what would fix it. `unknown step "clik" — did you mean "click"?` is the standard.
- Quote the offending value with `JSON.stringify` so an empty string or a stray space is
  visible.
- Never surface a raw zod dump, a stack, or an internal type name.

### Spelling and naming

- **American spelling in prose and comments**: color, behavior, license, honored,
  unrecognized.
- **Identifiers follow the platform**, so code says `color`, `colorScheme`, `stroke`.
- **`shotlist` is lowercase**, always, including at the start of a sentence.

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
- **A fixture the same length as the index under test hides an off-by-one.** `nth: -2` and
  `nth: 0` are the same element in a list of two. Break the implementation and watch the
  test fail before you believe it.
