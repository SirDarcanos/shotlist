# Domain documentation

`CONTEXT.md` is the canonical glossary for project concepts. Use its preferred terms in
plans, issues, tests, errors, and documentation, because synonyms make the declarative
language harder to search and easier to misread.

Update the glossary through `/domain-modeling` when a real distinction is missing. Keep it
to domain definitions; implementation details belong in code or the branch-specific agent
documents.

ADRs live under `docs/adr/` when they exist. Read every ADR touching the area being changed
before reopening its decision. Surface a contradiction explicitly rather than silently
implementing against it.

Create an ADR only for a decision that is hard to reverse, surprising without context, and
the result of a real trade-off. The absence of `docs/adr/` means no decision has yet earned
that record, rather than that an empty directory is missing.
