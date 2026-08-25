---
status: accepted
---

# Require Operator authority before opening a Run

A Run requires explicit Operator authority and loads every config-directed Library path
through one policy gateway before exposing the Project. Config document parsing remains
authority-free, the CLI explicitly preserves its trusted default, and effectful library
interfaces require the immutable Run rather than treating missing authority as trusted.

## Considered options

Optional authority preserves compatibility but leaves omission as an unrestricted mode. A
Run that owns every filesystem, browser, and process effect concentrates unrelated
lifetimes behind a shallow interface. The policy-gateway design keeps those effects with
their existing modules while concentrating authorization and its test surface at one seam.

## Consequences

The public migration is atomic before 1.0: no trusted fallback remains after contraction.
Library loading, linting, capture, checking, login, steps, serving, and baseline access all
use the same policy implementation, while browser and server ownership remain unchanged.
