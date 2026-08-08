# shotlist

Take annotated UI screenshots from YAML recipes, using Playwright.

shotlist opens your running site, drives it to the state you describe, clips a region,
draws callouts on it, and writes the image where you want it. Each screenshot is a YAML
file. There is no per-screenshot code.

> **Status:** the pipeline works end to end — driving the site, clipping, drawing the
> callouts, installing, and `--check`. 0.1.0 is the first release carrying it; the 0.0.1
> on npm predates all of it. See [CHANGELOG.md](./CHANGELOG.md).

## Install

```bash
npm i -D shotlist playwright
```

Playwright is an optional peer dependency. shotlist does not install it, because its
postinstall downloads browsers.

## Quick start

```bash
npx shotlist --init
```

writes a commented `shotlist.config.yaml` and a first recipe to edit. Or set the two up
by hand:

**1. Configure the project once** — `shotlist.config.yaml` in the project root:

```yaml
site:
  url: http://localhost:3000
  viewport: { width: 1440, height: 900 }
  scale: 2
  theme: dark

install:
  guide: content/guide/images
  social: assets/social
```

**2. Write a recipe** — `screenshots/recipes/order-row.yaml`:

```yaml
name: order-row
install: guide

setup:
  - click: { role: button, name: Orders }

clip:
  css: '.order-row'
  contains: Acme Corp
  pad: 20

marks:
  amount: { within: clip, text: $42.00 }
  status: { within: clip, text: Open }

callouts:
  - { mark: amount, text: What they owe, place: left }
  - { mark: status, text: Where it stands, place: right }
```

**3. Shoot it:**

```bash
npx shotlist order-row --install
```

The image is written to `screenshots/out/order-row.png`, and `--install` copies it to
`content/guide/images/order-row.png`.

## Configuration

| Key                  | Default               | What it sets                                                                 |
| -------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `site.url`           | required              | Where the site is running                                                    |
| `site.serve`         | —                     | Command that starts the site, when nothing answers at `site.url`             |
| `site.viewport`      | `1280 × 800`          | Browser size                                                                 |
| `site.scale`         | `2`                   | Device pixel ratio; `2` gives Retina images                                  |
| `site.theme`         | `light`               | `light`, `dark` or `no-preference`                                           |
| `site.reducedMotion` | `true`                | Disables animation before capture                                            |
| `site.ready`         | —                     | Selector waited for after each navigation                                    |
| `site.settle`        | `0`                   | Extra milliseconds to wait after `ready`                                     |
| `site.timeout`       | `15000`               | Per-step timeout in milliseconds                                             |
| `paths.recipes`      | `screenshots/recipes` | Where recipes live                                                           |
| `paths.macros`       | `screenshots/macros`  | Where macros live                                                            |
| `paths.data`         | `screenshots/data`    | Where data files live                                                        |
| `paths.out`          | `screenshots/out`     | Where images are written                                                     |
| `install`            | `{}`                  | Named destinations you refer to by name in a recipe                          |
| `finders`            | `{}`                  | Named query aliases (see [Finders](#finders))                                |
| `check.threshold`    | `0.002`               | Fraction of pixels that may differ before `--check` calls a shot changed     |
| `check.tolerance`    | `8`                   | How far one channel may move, out of 255, before a pixel counts as differing |

### Starting the site

shotlist expects the site at `site.url` to be running. `serve` lets a run start it:

```yaml
site:
  url: http://localhost:3000
  serve: npm run dev
```

**A server that is already up is used as it is.** shotlist fetches `site.url` first and
starts nothing when something answers, so `serve` can stay in the config while you write
recipes with the dev server open in another terminal. CI, where nothing is listening, is
where it actually launches one.

What a run starts, it stops — including on Ctrl-C. The command runs in its own process
group, because `npm run dev` is npm, which spawns the server: signalling only the process
shotlist launched would leave the one holding the port, and the next run would find it
answering and quietly shoot the old build.

The mapping form takes the rest:

```yaml
site:
  serve:
    command: npm run dev
    ready: 3000 # a http(s) URL, a port, or { log: <pattern> }
    cwd: apps/web # resolved from the config file's directory
    env: { PORT: '3000' }
    timeout: 30000
```

`ready` is what proves the server is up, and defaults to fetching `site.url`. A URL is
ready on any response at all, including a 404: that something answered is the question,
not what it said. A port is ready when it accepts a connection, and `{ log: … }` when the
pattern matches the server's output.

**There is no shell.** The command is run directly, so `&&`, `|`, `>` and a `VAR=value`
prefix are refused rather than half-understood — environment goes under `env:`, and
anything that genuinely needs a shell goes in a script you run instead. A config file
that could reach a shell would make shooting somebody else's checkout a different kind of
decision than it is.

A run of only `source: file` recipes never opens the site, and does not start one.

### Style

Every drawing constant is configurable. These are the defaults:

```yaml
style:
  color: '#DC2626' # boxes, arrows, discs
  canvas: '#FFFFFF' # fills space added around the image for labels
  box: { width: 6, radius: 10, pad: 8 }
  arrow: { shaft: 6, headHalf: 19, headLength: 38 }
  label:
    font: 'Arial, Helvetica, sans-serif'
    weight: 700
    size: 44
    fill: '#FFFFFF' # glyph fill
    stroke: '#DC2626' # outline around the glyphs; defaults to `color`
    strokeWidth: 6 # centred on the outline, so half of it is under the fill
    gap: 40 # distance from the box
    fontUrl: # optional stylesheet to load before drawing — see Fonts
  number:
    radius: 26
    size: 40
    fill: '#DC2626' # the disc; defaults to `color`
    text: '#FFFFFF' # the numeral
  mask:
    fill: '#94A3B8' # what a masked region is painted with
```

Sizes are in image pixels, so they do not change when `scale` does.

A recipe may override any of these under its own `style:` key.

### Fonts

**A font has to be resolvable by the browser doing the drawing.** By default that means
installed on the machine, and a family that is not installed **falls back silently** —
every label renders in another typeface with nothing to say so. shotlist measures the
rendered text to catch that and warns:

```
  ✓ order-row → screenshots/out/order-row.png
    ! label.font asks for Inter first, which is not available here; Arial was used instead
```

It is a warning, not an error: a fallback still produces an image, and which faces a
machine has is not something a recipe can know.

To use a font that isn't installed — a Google Font, or your own — give `fontUrl` a
stylesheet. It is fetched when the callouts are drawn, so this needs network access at
shoot time.

```yaml
style:
  label:
    fontUrl: https://fonts.googleapis.com/css2?family=Inter:wght@700&display=swap
    font: 'Inter, Arial, sans-serif'
```

**`strokeWidth` is centred on the glyph outline**, so half of it is painted under the
fill and half shows outside. A 6-pixel stroke reads as a 3-pixel outline. Tools that draw
the stroke entirely outside — Pillow's `stroke_width`, for one — need roughly double the
number here to match.

## Recipes

| Field      | Default    | What it does                                              |
| ---------- | ---------- | --------------------------------------------------------- |
| `name`     | filename   | Output filename, without the extension                    |
| `source`   | `app`      | `app` drives the site; `file` annotates an existing PNG   |
| `file`     | —          | The PNG to annotate, with `source: file`                  |
| `install`  | —          | Which named destination to copy to                        |
| `url`      | `site.url` | Page to open for this recipe                              |
| `viewport` | site's     | Viewport for this recipe                                  |
| `scale`    | site's     | Device pixel ratio for this recipe                        |
| `theme`    | site's     | Colour scheme for this recipe                             |
| `style`    | —          | Style overrides for this recipe                           |
| `setup`    | `[]`       | Steps that drive the site into the state to capture       |
| `clip`     | `viewport` | The region to capture: `viewport`, `full`, or a query     |
| `marks`    | `{}`       | Named regions, resolved after `setup` runs                |
| `mask`     | `[]`       | Regions painted over before the callouts are drawn        |
| `callouts` | `[]`       | What to draw on those marks                               |
| `numbered` | —          | Marks to number 1…n with a disc, in the order given       |
| `retries`  | `0`        | How many times to shoot this again if it fails, up to 5   |
| `check`    | project's  | This recipe's own `--check` limits, or `false` to skip it |

## Steps

Each step is a mapping led by one verb. Some verbs take extra keys.

| Step                             | Does                                                  |
| -------------------------------- | ----------------------------------------------------- |
| `goto: <url>`                    | Navigate                                              |
| `click: <query>`                 | Click an element                                      |
| `dblclick: <query>`              | Double-click                                          |
| `hover: <query>`                 | Move the pointer onto an element                      |
| `fill: <query>` + `value:`       | Set the value of an input                             |
| `select: <query>` + `option:`    | Choose an option; `optionLabel:` matches visible text |
| `check:` / `uncheck: <query>`    | Set a checkbox                                        |
| `press: <key>` + `on:`           | Press a key, optionally after focusing an element     |
| `type: <text>` + `on:`           | Type text                                             |
| `blur: <query>`                  | Remove focus                                          |
| `scrollIntoView: <query>`        | Scroll an element into view                           |
| `wait: <ms \| query>`            | Wait a fixed time, or until an element exists         |
| `readValue: <query>` + `as:`     | Read an input's value into a variable                 |
| `use: <macro>` + `with:`         | Run a macro                                           |
| `repeat: <n>` + `steps:`         | Run steps n times                                     |
| `each: <list>` + `as:`, `steps:` | Run steps once per item                               |
| `optional: [steps]`              | Run steps, ignoring failures                          |
| `openPage: <url>` + `as:`        | Open a second page and name it; `viewport:` sizes it  |
| `usePage: <name>`                | Switch which page later steps drive                   |

Any step also takes `comment:`, for a note to the next person reading the recipe.

There is no step that evaluates JavaScript. If a screenshot cannot be described with
these, that is a missing verb — see
[CONTRIBUTING.md](./CONTRIBUTING.md#adding-a-step-verb-or-a-query-primitive).

## Queries

A query says which element to act on or measure. Keys combine: sources choose the
candidates, filters narrow them, traversal moves from them, and selection picks one.

### Sources

| Key           | Matches                                     |
| ------------- | ------------------------------------------- |
| `css`         | A CSS selector                              |
| `role`+`name` | ARIA role and accessible name               |
| `label`       | Form control by its label                   |
| `placeholder` | Input by placeholder text                   |
| `testid`      | `data-testid`                               |
| `text`        | Element whose trimmed text equals the value |
| `startsWith`  | Element whose trimmed text begins with it   |
| `heading`     | `h1`–`h6` with this exact text              |

`text` and `startsWith` also narrow a source written alongside them. `exact: true` makes
`role`+`name`, `label` and `placeholder` match the whole string, case-sensitively, instead
of a substring.

**`role`, `label`, `placeholder` and `testid` cannot be used inside `span:` or `within:`.**
The browser resolves them before the page is searched, so there is nothing for a nested
one to narrow. Use `css`, `text`, `startsWith` or `contains` there; the error says so if
you forget.

### Filters

| Key                           | Keeps elements that…                       |
| ----------------------------- | ------------------------------------------ |
| `contains`                    | contain this text                          |
| `containingAll`               | contain all of these strings               |
| `matching`                    | have text matching this regular expression |
| `maxChildren` / `minChildren` | have at most / at least this many children |
| `minWidth` `maxWidth`         | are within these widths                    |
| `minHeight` `maxHeight`       | are within these heights                   |
| `narrowerThan` / `widerThan`  | are narrower / wider than this             |
| `visible`                     | have a non-zero size                       |
| `within`                      | sit inside an already-resolved mark        |

Sizes take pixels (`400`) or viewport units (`95vw`, `50vh`).

### Traversal

| Key        | Moves to                                      |
| ---------- | --------------------------------------------- |
| `ancestor` | The first ancestor matching the filters given |
| `parent`   | The parent element                            |
| `child: n` | The nth child                                 |
| `children` | All children                                  |

`ancestor` climbs from the element's parent — an element is never its own ancestor, so a
box that already fits the filters is not the answer. It takes `pick: nearest` (default) or
`pick: outermost`; `outermost` keeps climbing while the parent also matches — this is how you reach a modal's card rather
than stopping at the heading inside it.

### Selection and shape

| Key                                          | Effect                                  |
| -------------------------------------------- | --------------------------------------- |
| `pick: first \| last \| smallest \| largest` | Which candidate to use                  |
| `nth: n`                                     | The candidate at this position          |
| `pad: n`                                     | Grow the resulting box on all sides     |
| `grow: { top, right, bottom, left }`         | Grow it on specific sides               |
| `span: [query, query]`                       | The bounding box of several queries     |
| `rect: [x, y, width, height]`                | A literal box, for recipes with no page |

## Finders

Name a query in `finders:` and recipes can call it by name. `$1`, `$2` are the
arguments.

```yaml
finders:
  # The smallest box holding both a name and an amount.
  listRow:
    css: 'li, div'
    contains: $1
    matching: '\$\d'
    maxChildren: 12
    pick: smallest

  # The card owning a heading, climbed out of its full-screen overlay.
  panel:
    heading: $1
    ancestor: { narrowerThan: 95vw, pick: outermost }
```

```yaml
clip: { listRow: Acme Corp }
marks:
  dialog: { panel: Edit order }
```

## Callouts

A callout marks one region. `place` says which side of it the label goes on; shotlist
works out the position, extends the canvas if the label needs room outside the image, and
moves a label further out if it would overlap one already drawn.

Labels always sit outside the screenshot, never over it, with an arrow reaching in. The
canvas also grows for a box or a numbered disc that would otherwise be cut by the edge of
the shot.

**`place` defaults to `auto`, which picks a side.** A label to the left or right grows the
canvas by its _width_, one above or below by its _height_ — on a wide shot that is a
difference of hundreds of pixels. `auto` weighs that against how far the arrow would have
to travel, and against whether its path would cross another mark or a masked region.

`auto` also decides whether the label goes **over the shot or in a margin**. Over the shot
costs no canvas at all and needs only a stub of an arrow, so it wins wherever the shot has
nothing there — which it works out by reading the pixels the label would cover. A region
of one flat colour counts as nothing: it is the detail in a region that is worth not
covering, not its darkness.

What it cannot judge is what that detail is _for_. An arrow drawn across a paragraph is
not something it knows to avoid, so **name a side when the shot needs one** — an explicit
`place` is obeyed exactly, and so is an explicit `inside`.

| Field    | Default   | What it does                                                                |
| -------- | --------- | --------------------------------------------------------------------------- |
| `mark`   | required  | Which mark to draw on                                                       |
| `text`   | —         | Label text: one string, or a list with a line each                          |
| `n`      | —         | Number shown in a disc, for matching a numbered list in the prose           |
| `place`  | `auto`    | `auto`, `left`, `right`, `top`, `bottom`, or `corner` for a disc inside     |
| `badge`  | `tl`      | Which anchor, with `place: corner`: `tl` `tc` `tr` `ml` `mr` `bl` `bc` `br` |
| `box`    | `true`    | Whether to draw the outline                                                 |
| `inside` | see below | Whether the label or disc sits over the shot instead of in a margin         |
| `dx`     | `0`       | Nudge across, in image pixels, for what geometry alone cannot place         |
| `dy`     | `0`       | Nudge down, in image pixels                                                 |
| `pad`    | style's   | Distance between the outline and the element                                |
| `gap`    | style's   | Distance between the label and the outline                                  |

Left unsaid, a disc (`place: corner`) sits inside, on the box; a label on a named side
sits outside, in a margin the canvas grows to make; and a label on `place: auto` goes
wherever the shot has room for it. Saying `inside` either way settles it.

`numbered: [a, b, c]` is shorthand for one numbered disc per mark, in order. Give it the
style every disc shares by writing it out:

```yaml
numbered:
  marks: [header, abilities, defenses, traits]
  box: false # number the sections without outlining them
  badge: ml # anchored to the middle of the left edge
  inside: false # pushed clear, into the margin
```

## Macros and data

Setup shared between recipes goes in `paths.macros`, one file per macro. The filename is
its name.

```yaml
# screenshots/macros/sign-in.yaml
defaults:
  who: sam@example.com
steps:
  - fill: { label: Email }
    value: $who
  - click: { role: button, name: Sign in }
```

```yaml
setup:
  - use: sign-in
  - use: sign-in
    with: { who: admin@example.com }
```

Files in `paths.data` are in scope by filename: `screenshots/data/orders.yaml` is
`$orders`, and `each: $orders` iterates it.

The filename becomes a `$name`, so keep it to letters, digits and underscores — a
`$` reference stops at a hyphen, and `open-orders.yaml` cannot be reached. Group what
would have been several hyphenated files into one and read them by path: `$orders.open`,
`$orders.shipped`.

## Annotating an existing image

For screens a script cannot reach — anything behind a sign-in you cannot automate, or a
browser extension's UI — point a recipe at a PNG. Callouts, style and install work the
same way.

There is no page to query, so marks are literal rectangles measured off the image:
`[x, y, width, height]` in image pixels.

```yaml
name: billing-settings
source: file
file: captures/billing-settings.png
install: guide

marks:
  plan: { rect: [866, 874, 150, 50] }

callouts:
  - { mark: plan, text: The current plan, place: top }
```

## When a shot fails

A run stops at the first recipe that fails, and says which recipe and which key in it
could not be resolved. `--keep-going` shoots the rest instead, prints each failure as it
happens, and names them all at the end:

```bash
npx shotlist --all --keep-going
```

```
  ✓ modal → screenshots/out/modal.png
  ✗ recipe "order-row": marks.amount — no element matched {"css":".amount"}
1 of 2 failed: order-row
```

Either way the exit code is non-zero, so CI still fails. `--keep-going` works the same
way with `--check`, where a recipe that could not be shot is reported `FAILED` alongside
the ones that did diff.

A capture drives a real application, so some failures are gone a second later — an
element that had not rendered, a request that had not landed. `retries` says a recipe is
one of those:

```yaml
name: order-row
retries: 2 # three attempts in all
```

Each attempt is a fresh browser context, and the run reports the ones that failed while
it is still going rather than after the fact. A `source: file` recipe never retries: it
has no page to be flaky about, so shooting it again would only report the same mistake
more slowly.

## Masking what the recipe does not decide

A shot holding a clock, a live total or a face differs on every re-shoot, and `--check` on
it only ever cries wolf. `check: false` turns the check off for the whole image; `mask`
covers just the part that moves and leaves the rest checkable:

```yaml
name: dashboard
clip: { css: '.panel' }
mask:
  - { within: clip, css: '.updated-at' }
  - { css: '.avatar' }
```

**Key a mask on something that survives the value changing.** A class, a test id, a
position — never the content itself. `{ text: $42.00 }` matches the figure you are hiding
today and nothing at all tomorrow, when it reads `$51.00`. That failure is loud rather
than silent: a mask matching nothing stops the run with
`recipe "…": mask[0] — no element matched`, so you get a broken build instead of an
unmasked screenshot quietly reporting drift for ever. Loud is the right way round, but it
does mean a mask written against the content breaks the run rather than degrading.

Any query works, so an element with no class and no test id is still reachable:

```yaml
mask:
  - { within: clip, css: span, nth: 2 } # the third span, whatever it says
  - { within: clip, child: 2 } # the third child of the clip
  - { rect: [172, 84, 52, 20] } # a literal box, measured once
  - { span: [{ css: '.total' }, { css: '.row button' }] } # between two anchors
```

`nth` and `child` count from zero. The regions are painted before the callouts are drawn,
so a callout may still point at, and outline, a masked box — you can label a field whose
value you are hiding.

With `source: file` there is no page to query, so a mask is a literal
`rect: [x, y, width, height]`, the same as a mark.

## A shot with one part that always changes

`mask` hides the region in the image. When the region has to _stay_ in the image — the
result of a roll, a live figure the screenshot is about — `check.ignore` shoots it as it
is and leaves its contents out of the comparison instead:

```yaml
name: roll-form
clip: { css: '.card' }
check:
  ignore:
    - { css: 'output#result' }
```

The rest of the card is still checked at the usual threshold, so a layout change anywhere
else trips it.

**Only the contents are excused, not the geometry.** The region is blanked where it
resolves to _now_, in both images — so if the box moves or changes size, what it used to
cover is still compared, and the difference is reported. A shot whose widget renders
nothing at all fails outright, because the query matches nothing. That is the assertion
`check: false` gives up: it says the shot still works, without saying anything about what
is inside.

A result that skipped something says so, so a pass is not read as covering the whole
image:

```
  same     roll-form  (1 region not compared)
```

## Checking for stale screenshots

```bash
npx shotlist --check
```

Re-shoots every recipe and compares each against the committed image, reporting the ones
that changed. Exits non-zero if any did, so it can run in CI.

A percentage says a shot moved; it does not say what moved. `--diff` writes a three-up
into `<paths.out>/diff/` for each one that did — the committed image, the re-shot one, and
the re-shot one again with every changed pixel tinted:

```bash
npx shotlist --check --diff
```

```
  CHANGED  order-row — 2.13% of pixels differ
           committed: content/guide/images/order-row.png
           re-shot:   screenshots/out/order-row.png
           diff:      screenshots/out/diff/order-row.png
```

When the two are different sizes there is nothing to overlay, so the image is the two
panels and the size change is the whole story.

`--json` reports the run on stdout instead, with everything written for a person moved to
stderr, so the redirect is a usable file:

```bash
npx shotlist --check --json > report.json
```

```json
{
  "changed": 1,
  "total": 2,
  "drift": [{ "field": "chromium", "was": "141.0.0.0", "now": "139.0.0.0" }],
  "results": [
    {
      "name": "order-row",
      "status": "changed",
      "ratio": 0.0213,
      "shot": "screenshots/out/order-row.png",
      "against": "content/guide/images/order-row.png",
      "diff": "screenshots/out/diff/order-row.png"
    }
  ]
}
```

`status` is one of `same`, `changed`, `new`, `skipped` or `failed`, and `drift` is what
the machine-mismatch warning would have said — a CI job can tell a re-render apart from a
regression without parsing prose.

### What the images were taken with

`--install` also writes `shotlist.baseline.json` beside the config, recording the
shotlist, Playwright and Chromium versions and the platform. Commit it with the images.

A different Chromium rasterises text differently, and a different platform has different
faces to rasterise — either moves pixels without the site moving at all. When `--check`
runs somewhere else, it says so before the results, so a difference is not read as a
regression that was never there:

```
! this is not the machine the committed images were taken on:
    chromium: 141.0.0.0 → 139.0.0.0
    platform: darwin → linux
  Differences below may be that, rather than the site.
```

A field missing from either side is not a difference: an older record has no Chromium
version because nothing wrote one.

## CLI

```bash
npx shotlist --init               # write a starter config and recipe
npx shotlist                      # list every recipe
npx shotlist <name> [<name>…]     # shoot into paths.out
npx shotlist <name> --install     # …and copy to its install destination
npx shotlist --all --install      # shoot everything
npx shotlist --all --keep-going   # …carrying on past a recipe that fails
npx shotlist --check              # compare against committed images
npx shotlist --check <name>       # …just these ones
npx shotlist --check --diff       # …and write a before/after/changed image
npx shotlist --check --json       # …and report it as JSON on stdout
npx shotlist --config <file>      # use a specific config
npx shotlist --help               # the same list, from the tool
npx shotlist --version            # print the version
```

It exits non-zero when anything failed, and names the recipe and the key inside it that
could not be resolved:

```
recipe "order-row": marks.amount — no element matched {"css":".amount"}
```

## Using it from code

The command line is a thin wrapper. Everything it does is available directly:

```ts
import { check, loadConfig, loadLibrary, shoot, withNumbering } from 'shotlist'

const loaded = loadConfig()
const { paths, finders } = loaded.config
const library = loadLibrary({ ...paths, finders })

const recipe = withNumbering(library.recipes.get('order-row')!)
await shoot(recipe, library, loaded, { install: true })

const results = await check([recipe], library, loaded)
```

Pass a `browser` to `shoot` to reuse one across many recipes; without it each call
launches and closes its own.

## Editor support

The JSON Schemas ship with the package. Point at them for autocomplete and inline
validation:

```yaml
# yaml-language-server: $schema=../../node_modules/shotlist/dist/recipe.schema.json
```

`dist/schema.json` is the config, `dist/macro.schema.json` is a macro.

## Agent support

A skill for coding agents ships with the package. It covers what this README deliberately
does not: how to choose a query that survives a redesign, which side of a mark a label
belongs on, and what each error means. Copy it into a project and an agent will pick it
up:

```bash
mkdir -p .claude/skills
cp -R node_modules/shotlist/skills/shotlist .claude/skills/
```

It is Markdown with YAML frontmatter and nothing else, so any agent that reads instruction
files can use it — point yours at `node_modules/shotlist/skills/shotlist/SKILL.md`.

## What a config can do to the machine that runs it

A `shotlist.config.yaml` is a file in a repository. Whether that is fine depends entirely
on **whose repository**, and there are two answers.

**At a desk, on your own project**, a config is something you wrote, and it is allowed to
start your dev server and write images where you keep them. That is the default.

**In automation it is not.** A pull request from a fork can edit the config, and the
runner it lands on has your credentials, your network, and other people's work on it. A
service that shoots what strangers submit is the same problem with the volume turned up.
For that, run it with `--untrusted` (or `SHOTLIST_UNTRUSTED=1`, for a fixed command line):

```bash
npx shotlist --check --untrusted
```

|                                                         | default | `--untrusted` |
| ------------------------------------------------------- | ------- | ------------- |
| `site.serve` starts a process                           | yes     | **refused**   |
| opens `file:` and `data:` URLs                          | yes     | **refused**   |
| opens localhost, 10/8, 192.168, 169.254, cloud metadata | yes     | **refused**   |
| reads or writes outside the project                     | yes     | **refused**   |

It is set from the command line and the environment, never from the config: **a control
the config can switch off is not a control.**

**What is always true, either way.** A config cannot run code — there is no `eval:` step
and no way to reach one. Queries travel into the page as data, never as source, so a
malformed selector is a `SyntaxError` from `querySelectorAll` rather than an execution.
`site.serve` runs a program directly with no shell, so `&&`, `|`, `>` and a `VAR=value`
prefix are refused rather than interpreted. `site.timeout` bounds how long a query may
take, viewport and scale are held to what a browser can paint, and `retries` and `repeat`
are capped — so a run cannot be made to hang.

**What `--untrusted` does not do.** It reads the host out of the URL; it cannot see that a
name you allowed resolves to an address you did not. If you shoot what strangers submit,
put the runner somewhere that cannot reach anything it should not, and rate-limit it —
shotlist drives a real browser, so a recipe pointed at somebody else's site is traffic
you are sending, and a `fill:` step is a string you are typing into their forms.

**shotlist has no database and issues no SQL**, so there is nothing in it to inject into.
What it does have is a browser: a recipe is a script that types into whatever it is
pointed at, and a hosted one that lets a stranger choose both the target and the keystrokes
is an attack proxy for anything a browser can do — SQL injection through somebody else's
form included. `--untrusted` keeps that off your own network; keeping it off everyone
else's is the operator choosing what a submitted recipe may aim at.

## License

MIT © Nicola Mustone — see [LICENSE](./LICENSE).
