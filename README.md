# shotlist

Take annotated UI screenshots from YAML recipes, using Playwright.

shotlist opens your running site, drives it to the state you describe, clips a region,
draws callouts on it, and writes the image where you want it. Each screenshot is a YAML
file. There is no per-screenshot code.

**[shotlist.dev/docs](https://shotlist.dev/docs) is the reference** — every key, every step
verb, every query primitive. This file is the short version.

## Install

This is a [Node.js](https://nodejs.org/en/) module available through the
[npm registry](https://www.npmjs.com/).

Before installing, [download and install Node.js](https://nodejs.org/en/download/).
Node.js 20 or higher is required.

If this is a brand new project, make sure to create a `package.json` first with
the [`npm init` command](https://docs.npmjs.com/creating-a-package-json-file).

Installation is done using the
[`npm install` command](https://docs.npmjs.com/downloading-and-installing-packages-locally):

```bash
npm install -D shotlist playwright
```

pnpm and yarn work the same way.

Playwright is an optional peer dependency — shotlist does not install it, because its
postinstall downloads browsers. You need it whenever shotlist writes an image, which
includes `--check` and a `source: file` recipe, since the callouts are drawn in a page.
`--init`, `--help` and listing recipes need no browser and launch none.

## Quick start

```bash
npx shotlist --init
```

writes a commented `shotlist.config.yaml` and a first recipe. Or set the two up by hand:

**1. Configure the project once** — `shotlist.config.yaml` in the project root:

```yaml
site:
  url: http://localhost:3000
  viewport: { width: 1440, height: 900 }
  scale: 2
  theme: dark

install:
  guide: content/guide/images
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
  - { mark: amount, text: What they owe }
  - { mark: status, text: Where it stands }
```

**3. Shoot it:**

```bash
npx shotlist order-row --install
```

The image is written to `screenshots/out/order-row.png`, and `--install` copies it to
`content/guide/images/order-row.png`. PNG is the default; `image.format` also takes `jpeg`
and `webp`, per project or per recipe.

## Documentation

| Page                                                           | What it covers                                |
| -------------------------------------------------------------- | --------------------------------------------- |
| [Install](https://shotlist.dev/docs/install)                   | Setting up, and a first recipe                |
| [Configuration](https://shotlist.dev/docs/config)              | Every key, starting the site, style and fonts |
| [Recipes](https://shotlist.dev/docs/recipes)                   | Every field, and annotating an existing image |
| [Steps](https://shotlist.dev/docs/steps)                       | The step vocabulary                           |
| [Queries](https://shotlist.dev/docs/queries)                   | Sources, filters, traversal, finders          |
| [Callouts](https://shotlist.dev/docs/callouts)                 | Labels, numbered discs, masking               |
| [Macros and data](https://shotlist.dev/docs/macros)            | Sharing setup, driving a shot from a list     |
| [Running shotlist](https://shotlist.dev/docs/running-shotlist) | Every flag, the API, editor and agent support |
| [Checking for staleness](https://shotlist.dev/docs/check)      | `--check`, diffs, and a shot that changes     |
| [What a config can do](https://shotlist.dev/docs/security)     | What a run is allowed to reach                |

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
npx shotlist --login admin        # sign in by hand, and save the session
npx shotlist --help               # the full list, from the tool
```

## A recipe is data

A recipe is data. There is no step that evaluates JavaScript and there will not be one: if
a screenshot cannot be described, that is a missing verb or query primitive, and it gets
added. See [CONTRIBUTING.md](./CONTRIBUTING.md#adding-a-step-verb-or-a-query-primitive).

## Running a config you did not write

shotlist also runs in automation, where the config may come from a fork's pull request or
from whoever submitted it. A shot list only ever opens its own site, and never reads or
writes `.env`, `.git`, `.ssh` and their like — in every mode, with no flag to set. For the
rest, `--untrusted` starts no processes, opens nothing on the runner's own network, and
stays inside the project.

Full detail, and the two things it does not cover, at
**[shotlist.dev/docs/security](https://shotlist.dev/docs/security)**.

## Contributing

Any constructive contribution is welcome! You may contribute in any way you feel comfortable, from code for bug fixes and enhancements, to additions and fixes to documentation, additional tests, fixing a typo, and more!

Everything you need is in [CONTRIBUTING.md](./CONTRIBUTING.md): setup, the commands, the code style, and what "done" means.

## License

MIT © Nicola Mustone — see [LICENSE](./LICENSE).
