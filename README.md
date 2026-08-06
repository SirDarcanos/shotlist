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
  number: { radius: 26, size: 40, fill: '#DC2626', text: '#FFFFFF' }
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
| `callouts` | `[]`       | What to draw on those marks                               |
| `numbered` | —          | Marks to number 1…n with a disc, in the order given       |
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
| `openPage: <url>` + `as:`        | Open a second page and name it                        |
| `usePage: <name>`                | Switch which page later steps drive                   |

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
| `heading`     | `h1`–`h6` with this exact text              |

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

`ancestor` takes `pick: nearest` (default) or `pick: outermost`. `outermost` keeps
climbing while the parent also matches — this is how you reach a modal's card rather
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

**Choose the side with clear space.** The arrow travels from the margin to the box, so a
label placed on the far side of another element draws an arrow straight across it. That is
the one part of the layout shotlist cannot decide for you: it knows where the box is, not
which pixels matter.

| Field   | Default  | What it does                                                      |
| ------- | -------- | ----------------------------------------------------------------- |
| `mark`  | required | Which mark to draw on                                             |
| `text`  | —        | Label text                                                        |
| `n`     | —        | Number shown in a disc, for matching a numbered list in the prose |
| `place` | `right`  | `left`, `right`, `top`, `bottom`, or `corner` for a disc inside   |
| `badge` | `tl`     | Which corner, with `place: corner`                                |
| `box`   | `true`   | Whether to draw the outline                                       |
| `pad`   | style's  | Distance between the outline and the element                      |
| `gap`   | style's  | Distance between the label and the outline                        |

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

## Checking for stale screenshots

```bash
npx shotlist --check
```

Re-shoots every recipe and compares each against the committed image, reporting the ones
that changed. Exits non-zero if any did, so it can run in CI.

## CLI

```bash
npx shotlist                      # list every recipe
npx shotlist <name> [<name>…]     # shoot into paths.out
npx shotlist <name> --install     # …and copy to its install destination
npx shotlist --all --install      # shoot everything
npx shotlist --check              # compare against committed images
npx shotlist --config <file>      # use a specific config
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

## License

MIT © Nicola Mustone — see [LICENSE](./LICENSE).
