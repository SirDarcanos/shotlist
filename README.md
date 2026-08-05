# shotlist

**Repeatable, annotated UI screenshots from declarative recipes.**

A screenshot in your documentation is a bug the moment the UI moves on — and re-taking
one by hand is slow enough that it doesn't get done. shotlist drives your running site
with Playwright, clips the region you name, draws the callouts on it, and drops the
result where your docs expect it.

The part that matters: **a recipe is data.** No script per screenshot, no pixel
arithmetic, no file of drawing code that has to be edited every time a button moves.

```yaml
# screenshots/recipes/order-row.yaml
name: order-row
install: docs

setup:
  - click: { role: button, name: Orders }

clip:
  find: { listRow: Acme Corp }
  pad: 20

marks:
  amount: { within: clip, text: $42.00 }
  status: { within: clip, text: Open }

callouts:
  - { mark: amount, text: What they owe,   place: left }
  - { mark: status, text: Where it stands, place: right }
```

```bash
npx shotlist order-row --install
```

## Why the callouts aren't positioned by hand

`place: left` is the whole idea. shotlist measures the label, grows the canvas if the
label needs room outside the frame, routes the arrow to the nearest edge of the box, and
steps a label further out when it would collide with one already placed. You say which
side; it works out the geometry.

That is what makes a recipe survive a redesign. Move the button, re-run the recipe, and
the box still lands on it — because the box was never a coordinate.

## Install

```bash
npm i -D shotlist
```

Playwright is an **optional peer dependency**: its postinstall downloads browsers, and a
docs site shouldn't pay that on every CI install. Install it yourself if you haven't
already, and shotlist will drive the Chrome you have.

```bash
npm i -D playwright
```

## Config

One `shotlist.config.yaml` at your project root holds everything that is true of your
site rather than of one screenshot — where it runs, what the callouts look like, where
images install to.

```yaml
site:
  url: http://localhost:3000
  viewport: { width: 1440, height: 900 }
  scale: 2 # Retina
  theme: dark
  ready: 'text=Dashboard' # a selector proving the app booted

style:
  color: '#DC2626'
  label:
    fill: '#FFFFFF'
    stroke: '#DC2626'
    size: 44

install:
  docs: docs/assets/screens
  marketing: site/src/assets/shots
```

Nothing about any one site is baked into the package. Every colour, weight, font and
size above has a neutral default and is yours to change.

## Finders

Most elements are reachable with the accessible queries you already know — `role`,
`label`, `placeholder`, `text`, `css`. Some aren't: the card inside a full-screen
overlay, the row that is the smallest box holding both a name and an amount, the third
column of a grid.

Rather than dropping into JavaScript for those, shotlist has a small query language, and
you name the useful combinations once in your config:

```yaml
finders:
  # The smallest box holding both a name and an amount.
  listRow:
    css: 'li, div'
    contains: $1
    matching: '\$\d'
    maxChildren: 12
    pick: smallest

  # The modal card owning a heading — climbed out of its overlay.
  panel:
    heading: $1
    ancestor: { narrowerThan: 95vw, pick: outermost }
```

Recipes then just say `{ listRow: Acme Corp }` or `{ panel: Edit order }`.

## Editor support

Every schema ships with the package, so an editor with the YAML language server
autocompletes verbs, query keys and your own finder names as you type:

```yaml
# yaml-language-server: $schema=../../node_modules/shotlist/dist/recipe.schema.json
```

## Checking for staleness

```bash
npx shotlist --check
```

Re-shoots every recipe and compares it against the image you committed, so "which of our
screenshots are out of date?" is a command rather than an afternoon of scrolling.

## Screens a script can't reach

Anything behind a sign-in, or a browser extension's own UI, still gets captured by hand —
but it doesn't need a second pipeline. Point a recipe at the PNG and it gets the same
callouts, from the same config:

```yaml
name: billing-settings
source: file
file: docs/assets/incoming/billing-settings.png
```

## License

MIT © Nicola Mustone
