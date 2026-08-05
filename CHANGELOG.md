# Changelog

Notable changes to shotlist. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

**The recipe format is public API.** Renaming a step verb, removing a query key, or
changing what an existing key means is a breaking change, and says here exactly what to
edit. See [CONTRIBUTING.md](./CONTRIBUTING.md#what-counts-as-a-breaking-change).

## [Unreleased]

Nothing is published yet: everything below ships as 0.1.0.

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
`shotlist` CLI itself.
