---
name: shotlist
description: Use when a project needs annotated screenshots of its own web UI — for a handbook, a guide, docs, a landing page or a release post — and when writing, fixing or debugging shotlist recipes (`shotlist.config.yaml`, `screenshots/recipes/*.yaml`). Covers choosing queries that survive a redesign, placing callouts, and reading the errors a recipe fails with.
---

# Writing shotlist recipes

shotlist drives a running site, clips a region, draws callouts on it, and writes the
image. Every screenshot is a YAML recipe; there is no per-screenshot code.

[shotlist.dev/docs](https://shotlist.dev/docs) is the reference — every key, every default,
every step verb. Read it for _what a key does_. This skill is for the part the reference
cannot give you: **choosing a query that will still match after the next redesign**, and
placing a callout where it does not point across the thing it is naming.

## Before writing anything, look at the page

You cannot write a good query from a description. Open the page the recipe will shoot and
read the actual DOM around the target — `npx shotlist` needs the site running anyway.

Answer three questions first:

1. **What does a user see that identifies this element?** Its text, its heading, its
   accessible name. That is what the query should key on.
2. **What is the smallest box that contains everything the shot needs?** That is the clip.
3. **Which of the marks are inside that box?** Those get `within: clip`.

## Choosing a query

**Key on what a person can see, not on how it is built.** `text`, `heading`, `role`+`name`,
`label` and `placeholder` all survive a restyle. A generated class name — `.sc-x8f2a`,
`.css-1q2w3e` — does not survive the next build. Reach for `css` only for containers with
a stable, human-written class, and prefer narrowing it by content:

```yaml
# Brittle: breaks the next time the styling changes.
clip: { css: '.OrderRow__container--3fJ2k' }

# Durable: the row is whatever box holds this customer and an amount.
clip:
  css: 'li, div'
  contains: Acme Corp
  matching: '\$\d'
  maxChildren: 12
  pick: smallest
```

**`pick: smallest` is what makes "the row containing X" work.** Every ancestor of the row
also contains the text, right up to `<body>` — without it you clip the whole page. The
same applies to `pick: largest` when you want the container rather than the leaf.

**`ancestor` with `pick: outermost` is how you reach a card inside an overlay.** The
default `pick: nearest` stops at the first ancestor that matches, which is usually an
inner wrapper. `outermost` keeps climbing while the parent also matches:

```yaml
marks:
  dialog:
    heading: Edit order
    ancestor: { narrowerThan: 95vw, pick: outermost }
```

The `narrowerThan: 95vw` is doing real work: it is what separates the dialog's card from
the full-screen backdrop behind it, which also contains the heading.

**Scope marks to the clip.** A mark resolved against the whole page can match something
outside the shot, and the callout then points at nothing. `within: clip` confines it:

```yaml
marks:
  amount: { within: clip, text: $42.00 }
```

**When the same shape appears in three recipes, name it once.** Move it into `finders` in
the config and call it by name with `$1`, `$2`. A project's recipes should read like the
product, not like CSS.

**Verify rather than assume.** If you are unsure what a query resolves to, shoot it with a
box on the mark and no label, then look at the image. Guessing at a selector and shipping
it untested is the main way recipes rot.

**`role`, `label`, `placeholder` and `testid` do not work inside `span:` or `within:`.**
The browser resolves those before the page is searched, so a nested one has nothing to
narrow. Use `css`, `text`, `startsWith` or `contains` in those positions.

## Reaching inside an iframe

An iframe is a separate document, so an ordinary query cannot see into one. `frame:` names
it, and the rest of the query resolves in there:

```yaml
clip:
  frame: { css: 'iframe[title="Checkout"]' }
  css: '.order-total'
```

`frame` is a query like any other, so `nth`, `contains` and the rest all work on picking
the right iframe. The rect comes back in page coordinates, so callouts land correctly, and
a cross-origin frame — a payment widget, an embedded map — works the same. Steps take the
same queries: `click: { frame: { css: 'iframe' }, css: '#pay' }`.

`within:` naming a mark from the outer page is refused inside a frame; that rect belongs to
a document the frame knows nothing about.

## Masking what the shot must not check

A shot holding a clock, a live total or a face differs on every re-shoot, so `--check` on
it cries wolf and gets switched off. `mask` covers the part that moves and leaves the rest
checkable — better than `check: false`, which gives up the whole image.

The one rule: **a mask must key on something that survives the value changing.** This is
the mistake to avoid, and it is an easy one to make because it works the first time:

```yaml
# Wrong. Matches the figure today; matches nothing tomorrow, when it reads $51.00.
mask: [{ within: clip, text: $42.00 }]

# Right: a class, a test id, or a position — none of them the content.
mask: [{ within: clip, css: '.amount' }]
mask: [{ within: clip, testid: order-total }]
mask: [{ within: clip, css: span, nth: 2 }] # the third span, whatever it says
mask: [{ rect: [172, 84, 52, 20] }] # a literal box, measured once
```

`nth` and `child` count from zero. A mask that matches nothing stops the run rather than
producing an unmasked shot, so getting this wrong breaks the build — which is the right
way round, but it is still worth getting right the first time.

## Placing callouts

shotlist decides the geometry: it grows the canvas when a label needs room, and moves a
label that would overlap one already drawn. **It cannot decide which pixels matter.**

The arrow travels from the margin to the box, so a label placed on the far side of the
mark drags its arrow straight across whatever sits between them. Look at the shot and put
each label on the side with clear space — for a mark in the left third of the image, that
is almost always `place: left`.

- `inside: true` puts the label over the screenshot instead of in a margin. Outside never
  covers the interface but costs width; if there is empty space beside the mark, use it.
- `numbered: [a, b, c]` when the prose next to the image enumerates steps. Numbered discs
  default to sitting on the box; `inside: false` pushes them into the margin, which is how
  a column of numbers ends up beside a full-width section.
- A callout with no `text` and `box: true` is just an outline. That is often all a shot
  needs.

## Running it

```bash
npx shotlist                    # list the recipes this project has
npx shotlist order-row          # shoot one, into paths.out
npx shotlist order-row --install  # …and copy it where the config says
npx shotlist --all --install
npx shotlist --check            # re-shoot and compare against what is committed
```

If the site is not already running, give the config a `site.serve` — shotlist starts it,
waits until it answers, and stops it afterwards. It reuses a server that is already up, so
this is safe to leave in the config permanently.

For a set of recipes in CI, `--keep-going` finishes the run and reports every failure
rather than stopping at the first. For a shot that fails intermittently — an element that
had not rendered yet — give that recipe `retries: 2`.

## Shooting a page that needs signing in

A recipe never holds a password. Sign in once, and shotlist keeps the cookies:

```bash
npx shotlist --login admin      # a browser opens; sign in, then press Enter
```

```yaml
# shotlist.config.yaml — the file holds live cookies, so gitignore it
site:
  sessions:
    admin: { path: .shotlist/admin.json, verify: '#account' }
```

A recipe picks one by name, and the shot is taken as whoever that is:

```yaml
name: dashboard
session: admin
```

**Always give `verify` a selector only a signed-in page has.** An expired session does not
fail — it redirects — so without one every shot of the run becomes a picture of the sign-in
form, and `--install` commits them.

Where nobody can click, a macro signs in instead, reading only the variables the command
line allowed. Quote the reference: bare `${...}` is a flow mapping to YAML and will not
parse.

```yaml
# screenshots/macros/sign-in.yaml
steps:
  - fill: { css: '#username' }
    value: '${env.WP_USER}'
  - fill: { css: '#password' }
    value: '${env.WP_PASSWORD}'
  - click: { css: '#signin' }
```

```bash
npx shotlist --login admin --using sign-in --allow-env WP_USER,WP_PASSWORD
```

A project that always signs in the same way can name them in the config instead, and drop
the flag — `allowEnv: [WP_USER, WP_PASSWORD]`. Names only; the values stay in the
environment, and an `--untrusted` run ignores the list either way.

An `--untrusted` run loads no session and reads no variable.

## Checking a recipe without running it

`npx shotlist --lint` parses every config, recipe, macro and data file and reports what is
wrong with all of them at once. No browser, no site running — so it is the fastest way to
find a typo, and the right thing to run before shooting.

```
recipes/order-row.yaml
  ✗ clip: unknown key "marching" — did you mean "matching"?

1 error in 3 files
```

It checks shape, not truth: a `css` selector that matches nothing is only knowable against
a real page. `--warnings` adds what is legal but probably unmeant — a mark no callout
points at, an `install:` the config does not name — and never changes the exit code.

## When a recipe fails

Errors name the recipe and the key inside it. Match the message to the fix:

| What it says                                            | What to change                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `marks.amount — no element matched {…}`                 | The query. Check it against the live DOM; the page may need a `setup` step first |
| `clip — no element matched {…}`                         | Same, for the clip                                                               |
| ``setup — `click`: no element matched``                 | The step's query, or a missing `wait` before it                                  |
| `` `site.url` — could not open … Is the site running?`` | Start the site, or add `site.serve`                                              |
| `` `site.ready` — waited …, which never appeared``      | The readiness selector, or `site.settle` for what a selector cannot see          |
| `` `file:` — no file at …``                             | The path, which resolves from the config file's directory                        |
| `installs to "x", which the config does not define`     | The recipe's `install:`, or add the destination to the config                    |

A query that matches the wrong element fails differently: it succeeds and produces a wrong
image. That is why you look at the output.

## The rule

**A recipe is data.** There is no step that evaluates JavaScript, and there will not be —
do not look for one, and do not propose adding one.

If a screenshot genuinely cannot be described with the existing steps and query
primitives, that is a gap in the vocabulary, not a reason to write code around it. Say so
plainly, describe the shot that cannot be expressed, and point at
[CONTRIBUTING.md](https://github.com/SirDarcanos/shotlist/blob/main/CONTRIBUTING.md#adding-a-step-verb-or-a-query-primitive).
Most gaps turn out to be an existing primitive that was hard to find — check
[the query reference](https://shotlist.dev/docs/queries) before concluding one is missing.
