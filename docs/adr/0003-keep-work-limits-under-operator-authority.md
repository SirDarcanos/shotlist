---
status: accepted
---

# Keep Work limits under Operator authority

Every Run applies safe numerical Work limits to Library document size, authored structure,
Macro expansion, Step execution, and elapsed work. A Project cannot raise these limits;
only Operator authority may raise or lower numerical values. Unsafe `matching:` forms stay
forbidden because a Project-controlled escape or a numerical increase would restore work
that shotlist cannot bound reliably.

## Consequences

shotlist rejects predictable excess before site or browser startup and retains runtime
meters for values and website behavior that preflight cannot know. CLI options, protected
environment settings, and TypeScript callers translate Operator choices into the same Run
snapshot. This may refuse an existing large Project until its Operator raises a numerical
limit, but a Project cannot grant itself more work when a Run treats its input as hostile.
