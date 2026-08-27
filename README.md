# shotlist

Take annotated UI screenshots from YAML recipes, using Playwright.

shotlist opens your running site, drives it to the state you describe, clips a region,
draws callouts, and writes the image where you want it. You describe each screenshot in a
YAML recipe.

**[shotlist.dev/docs](https://shotlist.dev/docs) is the reference.** It covers each key,
step verb, and query primitive. This README covers setup and common commands.

## Install

shotlist requires [Node.js](https://nodejs.org/en/download/) 20 or newer and a project
with a `package.json`. Create one with
[`npm init`](https://docs.npmjs.com/creating-a-package-json-file) if needed.

Install shotlist and Playwright from the [npm registry](https://www.npmjs.com/):

```bash
npm install -D shotlist playwright
```

Use the equivalent pnpm or Yarn command if your project uses one of them.

shotlist keeps Playwright optional because Playwright downloads browsers during package
installation. Install it when shotlist writes an image, including runs with `--check` or a
`source: file` recipe. shotlist draws file-recipe callouts in a page. The `--init`,
`--help`, and recipe-listing commands do not launch a browser.

## Quick start

```bash
npx shotlist --init
```

shotlist writes a commented `shotlist.config.yaml` and a starter recipe. You can create
them by hand instead.

**1. Configure the project once** in `shotlist.config.yaml` at the project root:

```yaml
site:
  url: http://localhost:3000
  viewport: { width: 1440, height: 900 }
  scale: 2
  theme: dark

install:
  guide: content/guide/images
```

**2. Write a recipe** in `screenshots/recipes/order-row.yaml`:

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
  - { mark: amount, text: What they owe }
  - { mark: status, text: Where it stands }
```

**3. Shoot it:**

```bash
npx shotlist order-row --install
```

shotlist writes the image to `screenshots/out/order-row.png`. With `--install`, it copies
the image to `content/guide/images/order-row.png`. PNG is the default. Set `image.format`
to `jpeg` or `webp` in the project config or recipe.

## Documentation

| Page                                                                                             | What it covers                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| [Your first screenshot](https://shotlist.dev/docs/tutorials/first-screenshot)                    | A lesson: install, a recipe, a callout        |
| [Add shotlist to a project](https://shotlist.dev/docs/how-to/install)                            | Setting up in an app you already have         |
| [Configuration file](https://shotlist.dev/docs/reference/configuration)                          | Every key, starting the site, style and fonts |
| [Recipe file](https://shotlist.dev/docs/reference/recipe)                                        | Every field, and annotating an existing image |
| [Steps](https://shotlist.dev/docs/reference/steps)                                               | The step vocabulary                           |
| [Queries](https://shotlist.dev/docs/reference/queries)                                           | Sources, filters, traversal, frames, finders  |
| [Callouts and masks](https://shotlist.dev/docs/reference/callouts)                               | Labels, numbered discs, masking               |
| [Macros and data files](https://shotlist.dev/docs/reference/macros-and-data)                     | Sharing setup, driving a shot from a list     |
| [Command line](https://shotlist.dev/docs/reference/cli)                                          | Every flag, the API, editor and agent support |
| [Keeping a screenshot current](https://shotlist.dev/docs/tutorials/keeping-a-screenshot-current) | `--check`, diffs, and a shot that changes     |
| [Undo what a shot changed](https://shotlist.dev/docs/how-to/undo-what-a-shot-changed)            | `teardown`, for a recipe that writes          |
| [What a configuration can do](https://shotlist.dev/docs/explanation/security-model)              | What a run is allowed to reach                |

## Commands

```bash
npx shotlist --init               # write a starter config and recipe
npx shotlist                      # list every recipe
npx shotlist <name> [<name>…]     # shoot into paths.out
npx shotlist <name> --install     # …and copy to its install destination
npx shotlist --all --install      # shoot everything
npx shotlist --all --keep-going   # …carrying on past a recipe that fails
npx shotlist --check              # compare against committed images
npx shotlist --check --diff       # …and write a before/after/changed image
npx shotlist --check --json       # …and report it as JSON on stdout
npx shotlist --lint               # check every YAML; no browser, no site needed
npx shotlist --login admin        # sign in by hand, and save the session
npx shotlist --help               # the full list, from the tool
```

## Library API

Open one Run with the Operator authority your caller grants, then select Recipes from that
Run's Library:

```ts
import { openRun, shoot } from 'shotlist'

const run = openRun({ untrusted: false }, 'shotlist.config.yaml')
const recipe = run.project.library.recipes.get('order-row')!
await shoot(run, recipe, { install: true })
```

Capture, checking, Session, server, step, and Baseline functions require that Run. They
reject a hand-built Run or a copied Recipe before touching the browser, filesystem, network,
or a process. Operator authority comes from the caller rather than the Project config.

Lint cannot open a complete Run when the Project is malformed, so it takes authority
itself: `lint({ untrusted: false }, 'shotlist.config.yaml')`. Parsing values already in
memory remains authority-free through `parseConfig`, `parseRecipe`, `parseMacro`,
`parseLibrary`, and `parseQuery`.

## A recipe is data

Describe screenshots with recipe vocabulary rather than JavaScript. Contributors add a
step verb or query primitive for screenshots the vocabulary cannot express. shotlist does
not support `eval:` or other executable recipe fields. See
[CONTRIBUTING.md](./CONTRIBUTING.md#adding-a-step-verb-or-a-query-primitive).

## Running a config you did not write

Automation may run a config from a fork or another contributor. In every mode, shotlist
blocks secret-looking paths such as `.env`, `.git`, and `.ssh`. In `--untrusted` mode,
shotlist starts no configured process, loads no stored session, accepts approved HTTP(S)
hosts, and confines paths to approved roots.

Read the full policy and its limits in the
**[security model](https://shotlist.dev/docs/explanation/security-model)**.

## Contributing

You can contribute code or documentation, from bug fixes and tests to new features and
typo corrections.

[CONTRIBUTING.md](./CONTRIBUTING.md) covers setup, commands, code style, and the completion
criteria.

## License

MIT © Nicola Mustone. See [LICENSE](./LICENSE).
