# Changelog

Notable changes to shotlist. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

**The recipe format is public API.** Renaming a step verb, removing a query key, or
changing what an existing key means is a breaking change, and says here exactly what to
edit. See [CONTRIBUTING.md](./CONTRIBUTING.md#what-counts-as-a-breaking-change).

## [Unreleased]

### Fixed

- **An arrow started on the label's outline.** `getBBox()` measures the fill, and the
  outline is painted outside it, so a tail at the measured edge sat on the stroke it was
  meant to be clearing.
- **An arrow entered its box wherever the label sat, not at the box's middle.** The head
  followed the label's own height, clamped into the box's range, so a label that did not
  line up with what it named produced an arrow that read as having missed. It aims at the
  middle of the edge it approaches now, and runs at a slant when the two are not level.
- **An arrow to a label of several lines pointed off-centre.** The text is positioned from
  a hanging baseline rather than from the top of the ink, and the gap between the two was
  never measured — so the arrow was aimed at the middle of the anchor box instead of the
  middle of the writing. Worse, the probe that measures a label left the baseline at its
  default while the label itself is drawn hanging, which put the error at most of a line.

## [0.2.1] — 2026-08-06

### Fixed

- **The font warning fired on a working font stack.** A stack is an ordered list of
  acceptable choices, so a cross-platform one naming Segoe UI and Roboto has entries that
  do not resolve on any given machine by design. It warned on the first entry that did not
  resolve, which was every such stack, every run. It now warns only when _none_ of the
  families named is available — the case where every label really is set in the browser's
  default and nothing says so. `ui-sans-serif`, `ui-serif` and `-apple-system` also count
  as generic keywords rather than faces to hunt for.

## [0.2.0] — 2026-08-06

Everything below came out of pointing shotlist at a real application for the first time.

### Added

- **`inside` on a callout.** A label may sit over the screenshot instead of in a margin.
  Outside never covers the interface but costs width; a shot with clear space beside the
  mark was spending 40% of its canvas on one line of text. Discs default to inside, and
  `inside: false` pushes one clear of the box — which is how a column of numbers ends up
  in the margin beside a full-width section.
- **Eight anchors for a disc**, not four: `tc`, `ml`, `mr` and `bc` join the corners.
- **`dx`/`dy` on a callout**, in image pixels, for what geometry alone cannot place.
- **Multi-line labels.** `text:` takes a list, one line each.
- **`numbered:` takes options** — `marks`, plus the `box`, `badge`, `inside`, `dx`, `dy`
  and `pad` every disc shares. The plain list form is unchanged.
- **`startsWith`**, for a heading that carries its own suffix: "Legendary Actions
  (3/round, or 4 in lair)" is neither an exact match nor safely a substring.
- **`within` accepts a query**, not only the name of a resolved mark. Scoping a click to
  an open dialog was impossible: an application that renders a name in a list _and_ in
  the dialog above it gave two matches and no way to say which.
- **`nth`, `child` and `repeat` accept a `$name`.** A count reaching a numeric field had
  to be rewritten as a list to walk.
- **A finder called with `null`** takes no arguments, rather than being handed the string
  "null".

- **`check` on a recipe.** `false` skips it entirely, and a `threshold` or `tolerance`
  there overrides the project's for that recipe alone. A frame containing live dice or a
  clock differs on every re-shoot, and a staleness check that always reports a change is
  one nobody reads.
- **A warning when the font named is not available.** A family that is not installed
  falls back silently, so every label renders in another typeface with nothing to report
  it. `document.fonts.check()` is no help — it answers true for a family that does not
  exist — so the rendered text is measured instead.
- **`style.label.fontUrl`**, a stylesheet fetched before drawing, so a font that is not
  installed on the machine can still be used. Needs network access at shoot time.

### Removed

- **`findersModule`**, a config field for an escape hatch, declared before anything used
  it and never wired to anything. Five real captures were written without needing it, and
  an extension point that exists but is never exercised is a place for the query language
  to stop growing. A shape that cannot be expressed is a gap to fix in the language, with
  the shot that needs it as the evidence.

### Fixed

- **A label placed over the shot could land on another label, or on another mark's box.**
  Collision avoidance only ran for labels in margins.
- **A label placed over the shot could be clipped by the edge of the canvas.** The clamp
  measured the text but not the outline painted around it, and a label with no room beside
  its mark was pushed back over the mark instead of flipping to the other side.
- A step's own keys were interpolated together with the steps nested inside it, so `each`
  looked up its children's variables before the loop had bound them.
- A loop bound its variable onto its direct children only. A macro used inside a loop may
  loop again, and two levels down the outer variable had gone.

## [0.1.0] — 2026-08-06

The first release that can take a screenshot. 0.0.1 held the name and carried only the
recipe format.

### Added

- **The `shotlist` command line.**

  ```bash
  shotlist                       # list every recipe
  shotlist order-row --install   # shoot one and copy it to its destination
  shotlist --all --install       # shoot everything
  shotlist --check               # compare against the committed images
  ```

- **`--check`.** Re-shoots each recipe and compares it against the image at its install
  destination, reporting `same`, `CHANGED`, `NEW`, or `skipped` for a recipe that installs
  nowhere. Exits non-zero when anything needs attention, so it can run in CI. The
  comparison runs in the browser that took the shot, so no image library is needed.
- **`check.tolerance`**, how far one channel may move before a pixel counts as differing,
  beside the existing `check.threshold`.
- `shoot()` takes a `browser`, so a caller shooting a whole set launches one instead of one
  per recipe.

- **Shooting a recipe, end to end.** `shoot()` drives the site with Playwright, runs the
  recipe's steps, clips the region, resolves every mark, draws the callouts and installs
  the image. `source: file` annotates a PNG already on disk through the same drawing pass.
- **The step runner.** All twenty verbs, with macros expanded and `$name` resolved against
  the variables in scope where each step was written.
- **The drawing layer.** Outlined labels, block arrows, boxes and numbered discs, every
  constant taken from config. Labels are laid out in a margin outside the shot with an
  arrow reaching in, and are pushed along that margin so two never overlap.
- Playwright is resolved at run time from the project or the npx cache, so a project
  consuming shotlist does not pay for a browser download on every install.

### Fixed

- The canvas grows for a box or a numbered disc that would be cut by the edge of the shot,
  as it already did for a label. Marking an element that runs edge to edge used to lose
  half its stroke, and a disc on that box's corner was sliced in two.
- A call to a finder may carry its own query keys: `{ listRow: "Acme Corp", pad: 16 }` pads
  what the finder found. A second key used to stop the node looking like a call at all, so
  the finder's name was reported as an unknown query key.
- Canvas and clip sizes are whole pixels. A fractional canvas was rounded by the
  screenshot, and the image came back a pixel narrower than the layout said.

## [0.0.1] — 2026-08-05

An early release, published to claim the name. The layers below work and are tested;
there is no CLI yet, so the package is usable through its API and not from a terminal.

### Added

- **Project config** (`shotlist.config.yaml`). Where the site runs, what callouts look
  like, where recipes and images live, and the named install destinations a recipe
  selects with `install:`. Every drawing constant — colour, stroke, radius, font, label
  fill — is config with a neutral default, so nothing about any one site is baked in.
- **Recipes**: a screenshot described as data — `setup` steps, a `clip`, named `marks`,
  and `callouts` that say which side of a mark a label belongs on rather than where it
  goes in pixels.
- **A step vocabulary** of twenty verbs: `goto`, `click`, `dblclick`, `hover`, `fill`,
  `select`, `check`, `uncheck`, `press`, `type`, `blur`, `scrollIntoView`, `wait`,
  `readValue`, `use`, `repeat`, `each`, `optional`, `openPage`, `usePage`. No
  conditionals, no arithmetic, and deliberately no escape into JavaScript.
- **Macros** (`use:` + `with:`) for the setup a project repeats, with `defaults:` per
  macro, and **data files** whose contents are in scope as `$name`.
- **An element query language.** Sources (`css`, `role`, `label`, `placeholder`,
  `testid`, `text`, `heading`), filters (`contains`, `containingAll`, `matching`,
  `maxChildren`, size bounds, `within`), traversal (`ancestor`, `parent`, `child`,
  `children`), selection (`pick`, `nth`) and composition (`span`, `pad`, `grow`).
- **Query aliases.** A project names the awkward combinations once in `finders:` and
  recipes call them by name with `$1`-style arguments — the smallest box holding a name
  and an amount, the modal card climbed out of its overlay.
- **`pick: outermost` on `ancestor`**, which keeps climbing while the parent still
  matches. Without it a query for a modal's card stops at the heading inside it.
- **`rect: [x, y, width, height]`**, a literal box for recipes that annotate an existing
  image and so have no page to query.
- **Generated JSON Schemas** (`dist/schema.json`, `dist/recipe.schema.json`,
  `dist/macro.schema.json`) for editor autocomplete, produced from the same zod schemas
  that validate at run time, so the two cannot disagree.
- **Errors written for recipe authors**: the file, the path inside it, and a suggestion —
  `unknown step "clik" — did you mean "click"?`, and a misspelled finder is answered with
  the list the project actually defines.
- **A neutral fixture site** (`tests/fixture/`) exercising every query primitive, with
  `data-rect` attributes so the same queries can be tested in jsdom and in a real
  browser.

### Not here yet

The layers that turn a validated recipe into a PNG — running steps against Playwright,
drawing the callouts, capturing and installing, and `--check` for staleness — plus the
`shotlist` CLI itself. The README documents them; nothing in 0.0.1 runs them.

[unreleased]: https://github.com/SirDarcanos/shotlist/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/SirDarcanos/shotlist/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SirDarcanos/shotlist/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SirDarcanos/shotlist/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/SirDarcanos/shotlist/releases/tag/v0.0.1
