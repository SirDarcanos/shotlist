# Changelog

Notable changes to shotlist. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

**The recipe format is public API.** Renaming a step verb, removing a query key, or
changing what an existing key means is a breaking change, and says here exactly what to
edit. See [CONTRIBUTING.md](./CONTRIBUTING.md#breaking-changes).

## [Unreleased]

### Changed

- **`place` on a callout defaults to `auto`, which was `right`.** A label to the left or
  right grows the canvas by its _width_ and one above or below by its _height_, so on a
  wide shot the default cost hundreds of pixels of margin for no reason — a real recipe
  here went from 3782×1524 to 2880×1654 by moving two labels off the sides. `auto` weighs
  that against how far the arrow has to travel and whether its path crosses another mark
  or a masked region, and whether it can go over the shot rather than in a margin at all —
  which it settles by reading the pixels it would cover, a region of one flat colour
  counting as nothing worth keeping. On the recipe above that took the canvas to
  2880×1524, the shot's own size, with no margin anywhere. **A callout that relied on the
  old default now has to say `place: right`**; an explicit side is obeyed exactly as before, and `numbered` discs are
  unaffected because they are placed `corner`. What `auto` cannot see is the pixels
  nobody pointed at, so a shot whose arrow must miss a paragraph still wants a named side.

- **`ancestor` climbs from the element's parent, not from the element.** It started at the
  element itself, so whenever the filters happened to fit the element it answered with
  that — `{ heading: …, ancestor: { widerThan: 400, narrowerThan: 700 } }`, meant to climb
  out of a heading to the column holding it, matched the heading, because a heading is a
  block as wide as its column. The result was a box drawn round the wrong thing with
  nothing to say so. An element is not its own ancestor, which is what the README always
  said. **If a query of yours relied on the element matching itself, drop the `ancestor`
  key** — that is what it was doing. `pick: outermost` is unaffected in practice, since
  it climbed past the element anyway.

### Added

- **`--untrusted`, for running a config that is not yours.** The hardening so far assumed
  a desk: your project, your config, your machine. Automation inverts that — a pull
  request from a fork can edit the config, and the runner it lands on has credentials, a
  network position and other people's work on it; a service shooting what strangers submit
  is the same problem louder. With the flag (or `SHOTLIST_UNTRUSTED=1`, for a fixed
  command line) a run starts no processes, opens nothing but http(s), opens nothing on the
  network the runner sits in — localhost, 10/8, 192.168, 169.254, the cloud metadata
  names — and neither reads nor writes outside the project. It is set from the command
  line and the environment and never from the config, because a control the config can
  switch off is not a control. `repeat` is capped at 1000 for the same reason `retries`
  was capped at 5.

- **`check.ignore`, for a shot whose subject is the part that changes.** `mask` hides a
  region in the image, and `check: false` gives up on the shot entirely — neither helps
  when the volatile thing is what the screenshot is _of_. `check.ignore` shoots the region
  as it is and leaves its contents out of the comparison, so the rest of the shot stays
  checked at the usual threshold. Only the contents are excused: the region is blanked
  where it resolves to now, in both images, so a box that moved or resized still reports —
  what it used to cover is compared — and one that renders nothing fails outright, because
  the query matches nothing. That is the assertion `check: false` cannot make. A result
  that skipped something says `(1 region not compared)`, so a pass is not read as covering
  the whole image.

- **`--check --json`**, so a pipeline can act on a run rather than parse it. The report
  goes to stdout and everything written for a person moves to stderr, which is what makes
  `--check --json > report.json` leave a usable file. It carries each recipe's status and
  ratio, the diff written for it, and the environment drift — so a job can tell a
  re-render on a different Chromium apart from a regression without reading prose.

- **`--init`**, writing a commented `shotlist.config.yaml` and a first recipe. Starting a
  project meant copying two files out of the README into an empty directory and finding
  out which keys were required by being told. The scaffold parses, so `npx shotlist`
  lists `example` straight after it, and the recipe carries the `yaml-language-server`
  line that turns on editor completion. Neither file is overwritten: run it in a project
  that already has recipes and it writes only the half that was missing.

- **`--check --diff`, so a drift report shows what moved.** `2.13% of pixels differ` says
  a shot changed and nothing about how, which is the thing you need before deciding
  whether to bless it or fix it. It now writes a three-up per changed shot into
  `<paths.out>/diff/`: the committed image, the re-shot one, and the re-shot one again
  with every changed pixel tinted. Two panels when the sizes differ, since there is
  nothing to overlay. It is drawn in the browser that took the shot, so it costs no image
  library, and only a shot that actually moved pays for it.

- **`--check` says when it is not running on the machine that took the images.**
  `--install` now records the shotlist, Playwright and Chromium versions and the platform
  in `shotlist.baseline.json`, beside the config, to be committed with the images. A
  different Chromium rasterises text differently and a different platform has different
  faces to rasterise, so either moves pixels with the site untouched — and a check that
  reports `0.83% of pixels differ` and stops there sends somebody looking for a
  regression that was never there. The difference is now named before the results.

- **`mask` on a recipe**, for the part of a shot the recipe does not decide. A frame
  holding a clock, a live total or a face differs on every re-shoot, and until now the
  only answer was `check: false` — giving up drift detection on the whole image to
  tolerate one corner of it, which makes the check something nobody reads. `mask` takes
  the same queries as everything else, so a finder works and an element carrying neither
  a class nor a test id is still reachable — by position, or by a literal box. It has to
  be keyed on something that survives the value changing: `{ text: $42.00 }` matches the
  figure being hidden today and nothing at all tomorrow. A mask that matches nothing
  stops the run rather than quietly producing an unmasked shot that then reports drift
  for ever. Regions are painted before the callouts, so a callout may still outline a
  masked box. `style.mask.fill` sets the colour; it is neutral rather than the callout
  colour, because a mask is not pointing anything out.

- **A skill for coding agents**, at `skills/shotlist/SKILL.md` in the package. The README
  is reference — what every key does — and an agent writing its first recipe needs the
  other half: that a query should key on what a person can see rather than on a generated
  class name, that `pick: smallest` is what makes "the row containing X" resolve to the row
  and not to `<body>`, that `ancestor: { pick: outermost }` is how you reach a dialog's
  card out of its backdrop, and that shotlist places a label but cannot know which pixels
  it must not point across. Copy it to `.claude/skills/`; it is Markdown with frontmatter,
  so anything that reads instruction files can use it.

- **`site.serve`, so a run can start the site it shoots.** Until now `site.url` had to be
  answering already, and nothing said whose job that was — which is fine at a desk with
  the dev server in another tab, and is the whole problem in CI. `serve: npm run dev`
  starts it, waits until it is genuinely up, and stops it afterwards. It probes
  `site.url` first and starts nothing when something already answers, so it can stay in
  the config permanently rather than being a thing CI turns on: while you are writing
  recipes it uses the server you already have. `ready:` says what counts as up — a
  http(s) URL, a port, or `{ log: <pattern> }` — and defaults to fetching `site.url`. The
  command runs in its own process group and is stopped through it, including on Ctrl-C,
  because `npm run dev` is npm spawning the server and signalling only the process
  shotlist launched leaves the one holding the port. There is no shell: `&&`, `|`, `>`
  and a `VAR=value` prefix are refused with what to write instead, so a config file
  cannot become a way to run arbitrary shell in somebody else's checkout.

- **`retries:` on a recipe, for a shot that is flaky rather than wrong.** A capture drives
  a real application, and some of what it trips over — an element that had not rendered
  yet, a request that had not landed — is gone on the next attempt. `retries: 2` shoots
  three times before giving up, each in a fresh browser context, and reports the attempts
  that failed while the run is still going rather than after it. It is capped at 5,
  because a recipe whose query is simply wrong fails identically every time and a larger
  number only buys a slower way to be told so. A `source: file` recipe never retries: it
  has no page to be flaky about.
- **`--keep-going`, so one broken recipe does not decide the run.** A run stops at the
  first failure, which is the right answer when you are shooting one recipe and the wrong
  one when you are shooting forty in CI — the other thirty-nine had answers worth having.
  With the flag each failure is printed as it happens and named again at the end
  (`1 of 5 failed: broken`), and the exit code is still non-zero. It applies to `--check`
  too, where a recipe that could not be shot is now a `FAILED` result alongside the ones
  that diffed, rather than the end of the run.

### Fixed

- **`mask` and `check.ignore` covered only the first element their query matched.** A
  page has three avatars far more often than it has one, and a mask over `.avatar` shipped
  two of them. Both now cover every match; naming `pick` or `nth` still says you mean one.

- **A `fontUrl` could put script into the page the callouts are drawn in.** It was
  interpolated straight into a `<link href>`, so a value carrying a quote closed the
  attribute and opened a tag — in the page holding the screenshot. It is now held to a
  http(s), `data:` or `file:` URL _and_ escaped where it is written; the two checks fail
  independently.
- **A `matching` pattern could hang a run for ever.** It is a regular expression run
  inside the page against the text of every candidate, and one with nested quantifiers
  backtracks exponentially — 34 characters of the wrong text took 90 seconds here, and 40
  would have taken an hour. Resolving a query is now bounded by `site.timeout` and fails
  naming the query and the limit.
- **A viewport or scale past what a browser can paint crashed it.** `viewport: { width:
200000 }` took the tab down and reported a Playwright protocol error with the whole
  Chromium command line in it. Both are now bounded, separately and as the product they
  make: `4000 × scale 8` is refused for being 32000 device pixels rather than dying.
- **A recipe's `name` could climb out of the out directory.** `name: ../../elsewhere`
  wrote there. It names an image, so it may no longer contain a path.

- **A bad value in a union said `Invalid input` and stopped there.** Several keys accept
  more than one shape — `clip`, `numbered` and `check` — and a mistake inside one was
  reported as the union as a whole not matching, naming neither the key that was wrong nor
  what it should have been. The failure now follows the union into the branch that was
  plainly being written, so a misspelled key reads `numbered: Unrecognized key: "badgee"`.
  A branch that failed only because the value is the wrong type entirely is not one the
  author was attempting, and is left out; when no branch got further than that, zod's own
  summary stands.

- **A query that matched nothing reported itself in JavaScript.** The message was
  `page.evaluateHandle: Error: no element matched {…}` followed by a stack through
  `UtilityScript` — the query language is resolved by a function serialized into the
  browser, and the wrapping came out with it. It is the failure a recipe hits most often,
  and it named neither the recipe nor which of its keys was being resolved, so a project
  shooting a set of recipes was told what went wrong and not where it was written. A
  failure now reads `recipe "order-row": marks.amount — no element matched {…}`, and says
  `clip`, or ``setup — `click`:``, when it was one of those instead.
- **A site that was not running said `net::ERR_CONNECTION_REFUSED`.** The first thing a new
  project gets wrong is the one error that did not say which key to look at. It now names
  `site.url` — or the recipe's own `url` — and asks whether the site is up. A `site.ready`
  selector that never appears is likewise reported against `site.ready`, with what it
  waited for and for how long.
- **`source: file` failed on the PNG header rather than on the file.** A path that did not
  exist raised a bare `ENOENT` naming an absolute path nobody had written, and anything
  that was not a PNG raised `not a PNG` — no recipe, no filename, no fix. Both now name
  the recipe and `file:`, and both are checked before a browser is launched, since a typo
  should not cost the second it takes to start one.

- **The README's reference tables had fallen behind the schemas they describe.**
  `startsWith` and `exact` on a query, `inside`, `dx` and `dy` on a callout, `comment` on
  any step, and `viewport` on `openPage` all worked but appeared nowhere, and the CLI
  section was missing `--check <name>`, `--help` and `--version`. `style.number.fill` is a
  fallback to `color` rather than the fixed `#DC2626` the defaults block implied, so a
  project changing `color` was told its discs would stay red.

## [0.2.3] — 2026-08-06

### Fixed

- **A label above or below its mark was shaved by the edge of the canvas.** Only the side
  a label is placed on claimed a margin, but a label is centred on what it names — so one
  above a mark near the right edge overhung a canvas that never grew to hold it, and was
  slid back until it sat flush and lost half its outline. The margins are now measured on
  both axes, which fixes the mirror case as well: a label beside a mark at the top or the
  bottom of a shot.
- **A macro argument could not name a loop variable.** `use: set-hp` with
  `with: { who: $foe }` inside an `each` passed the four characters `$foe`, not the item —
  macro frames are built when the file loads, and `$foe` stands for nothing until the loop
  runs. Arguments are resolved against the scope the `use` was written in now, so a loop
  can drive a macro. A name nothing answers to is still left as written, for the frame
  below to fill.

## [0.2.2] — 2026-08-06

### Fixed

- **An arrow started on the label's outline.** `getBBox()` measures the fill, and the
  outline is painted outside it, so a tail at the measured edge sat on the stroke it was
  meant to be clearing.
- **An arrow entered its box wherever the label sat, not at the box's middle.** The head
  followed the label's own height, clamped into the box's range, so a label that did not
  line up with what it named produced an arrow that read as having missed. It aims at the
  middle of the edge it approaches now, and runs at a slant when the two are not level.
- **An arrow left a label of several lines from inside its first line.** The tail sat at
  the middle of the font's metric box, and `getBBox` reports that box identically for
  every line whatever its letters — so a line with a cap and a descender, which inks half
  again as tall as one with neither, dragged the middle up into itself. A canvas can
  measure the glyphs' real ink, and the tail now sits in the gap between the lines.
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

[unreleased]: https://github.com/SirDarcanos/shotlist/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/SirDarcanos/shotlist/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/SirDarcanos/shotlist/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/SirDarcanos/shotlist/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SirDarcanos/shotlist/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SirDarcanos/shotlist/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/SirDarcanos/shotlist/releases/tag/v0.0.1
