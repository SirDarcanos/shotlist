---
status: accepted
---

# Make Run execution the Capture and Checking seam

TypeScript callers use grouped Run execution rather than driving one Recipe through public
Capture or Checking functions, because one deep module must own selection, site and browser
lifetimes, cleanup, reporting, and installation order. A Run remains reusable between
requests but rejects overlap, and each request processes its Recipes sequentially through
shotlist-owned resources.

## Consequences

The package removes the direct `shoot` and `check` interfaces before 1.0 and exposes Capture
and Checking through the Run. Expected operational failures produce complete reports rather
than hiding earlier work behind a later exception. Installation starts only after every
selected Capture and its teardown succeed; each Committed image is replaced safely, but
shotlist does not promise one atomic replacement across several Install destinations.
