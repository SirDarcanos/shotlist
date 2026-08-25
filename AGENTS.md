# Building shotlist

## What shotlist is

shotlist drives a running site with Playwright, clips a region, draws callouts, and writes
an annotated UI screenshot where the project asks. Each screenshot is a YAML recipe, and
nothing in the package assumes whether the image belongs in a handbook, landing page,
release post, or store listing.

## A recipe is data

Extend a project with finders, macros, and data. Extend shotlist with a query primitive or
step verb when a real screenshot exposes a language gap. Keep recipes declarative, because
an executable escape hatch turns unused vocabulary into an unbounded programming language;
`eval:` and per-recipe JavaScript are outside the format.

## Context pointers

- **Contribution workflow**: Before editing files or deciding the work is done, read
  [`CONTRIBUTING.md`](./CONTRIBUTING.md); its setup, rules, repository layout, gate, and
  completion criteria apply to agents unchanged.
- **Domain language**: Before using project terms in plans or changes, read
  [`CONTEXT.md`](./CONTEXT.md) and [`docs/agents/domain.md`](./docs/agents/domain.md).
- **Writing**: Before changing prose, comments, errors, commit bodies, or pull request text,
  read [`docs/agents/voice.md`](./docs/agents/voice.md).
- **Language**: Before changing config, recipes, macros, interpolation, finders, queries, or
  schemas, read [`docs/agents/language.md`](./docs/agents/language.md).
- **Runtime**: Before changing CLI orchestration, browser steps, retries, teardown, site
  startup, sessions, or Playwright loading, read
  [`docs/agents/runtime.md`](./docs/agents/runtime.md).
- **Imaging**: Before changing clipping, frames, geometry, annotations, formats, comparison,
  or diffs, read [`docs/agents/imaging.md`](./docs/agents/imaging.md).
- **Security**: Before adding or changing a path, URL, command, session, environment value,
  or untrusted-mode behavior, read [`docs/agents/security.md`](./docs/agents/security.md).
- **Tests**: Before changing tests or fixtures, read
  [`docs/agents/testing.md`](./docs/agents/testing.md).
- **Issues**: Before a skill reads or writes tickets, read
  [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).
- **Triage**: Before triaging incoming work, read
  [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).
