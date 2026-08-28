# Declarative language

The Zod schemas in `src/config.ts`, `src/recipe.ts`, `src/query.ts`, and `src/step.ts`
define the authored language. TypeScript types are inferred and JSON Schemas are generated
from them, so a shape has one source of truth.

## Loading boundary

`loadConfig` finds or reads the config, applies defaults, and returns its file and root with
the parsed value. Resolve project paths from that root rather than the shell's current
directory.

`openLibrary` authorizes and reads direct YAML, YML, and JSON children from the configured
Recipe, Macro, and data directories. It parses Macros before Recipes, keys documents by
explicit name or filename stem, applies numbered-callout normalization after parsing, and
publishes one complete immutable Library or none of it. `parseLibrary` assembles documents
that a caller has already read without requiring Operator authority.

Most authored mappings are strict. Preserve addressed validation errors and typo
suggestions when extending a union, because raw Zod branches turn one misspelled key into a
screen of unrelated failures. Add a Step verb as one built-in declaration in `src/step.ts`;
`VERBS`, nested diagnostics, Macro expansion, and runtime dispatch derive from those
declarations.

## Finders and queries

A finder is a project-defined query template. Positional `$1`, `$2`, and later arguments
are substituted recursively, then caller-owned built-in keys override template keys.
Finder expansion may call another finder, but reports the complete chain when recursion is
detected.

A one-key object whose key is outside the built-in query vocabulary is a finder call. Add a
new object-valued data property to `NOT_A_QUERY` when its contents are not nested queries,
because `{ grow: { left: 4 } }` otherwise becomes a finder call named `left`.

Role, label, placeholder, and test-id sources use Playwright locators and enter
`resolveQuery` as seed elements. Nested `span` and query-valued `within` do not receive
independent seeds, so locator-only sources there fail explicitly rather than searching a
different candidate set.

`resolveQuery` is pure because Playwright serializes it into a page or frame. Keep its
helpers self-contained: imports, module state, and closure values do not cross
`page.evaluate`.

A resolved query carries its element and rectangle together. Preserve that pair through an
action, because resolving them separately can choose different candidates from a changing
page.

## Macros and interpolation

Macro expansion fixes the step structure before execution. It rejects unknown macros and
recursive expansion while retaining each expanded step's macro arguments.

Interpolation happens immediately before a step runs because `each`, macro arguments, and
`readValue` create runtime values. Scope precedence is library data, enclosing loop scope,
then macro arguments. A whole-value reference preserves its type; a reference embedded in
a larger string is stringified.

Missing whole-value references fail. Missing `${env.NAME}` references fail even inside a
larger string, because leaving a secret placeholder as literal text hides a denied or
misspelled environment name. Property lookup follows own properties and blocks
`__proto__`, `constructor`, and `prototype`.

Data documents deliberately have no schema. They extend values available to loops and
interpolation rather than the executable vocabulary.

## Work limits

Inspect Recipe and Macro Step trees iteratively before recursive schema validation. Library
opening refuses predictable work beyond the Run's Work limits; review retains all reachable
failures and warns when a measurement reaches 80%. Count Macro expansion separately from
actual Step execution because a small expansion can run many times through `repeat` or
`each`. Validate every `matching:` pattern after Finder expansion and again after Step
interpolation.

## Network destinations

`site.url` and `site.allow` contribute Network destination approvals only for a trusted Project. A bare `site.allow` host means HTTPS port 443. Use a full HTTP(S) destination for HTTP or an unusual port, and `*.example.com` for proper HTTPS subdomains without the apex. Application Recipes may use browser-contained `data:` and `blob:` content but may not navigate to `file:` URLs; File Recipes remain the controlled local-image path.

## Completion

Use the schema, documentation, and generated-artifact completion criteria in
`CONTRIBUTING.md`, because authored vocabulary is incomplete until its runtime schema,
editor schema, tests, bundled skill, and external reference agree.
