# Voice

`CONTRIBUTING.md` owns the rules for comments and errors. This document owns the prose
voice used in documentation, diagnostics, commit bodies, and pull request descriptions.
Match an established file; when it has no voice yet, use `src/capture.ts` and this document.

## State the claim and its reason

Write in the present indicative. Carry the reason in the same breath, because a rule
without its reason gets followed in the wrong place.

- Yes: `Run the gate unpiped — npm test | grep … reports grep's exit code.`
- No: `Always run the gate unpiped. This is important.`

Draw contrasts with “rather than,” because naming the alternative makes the failure
legible: `a step that has not finished produces a wrong screenshot rather than an error`.

Be concrete. `nth: -2 and nth: 0 are the same element in a list of two` teaches; “be
careful with negative indices” does not.

Cut filler such as `simply`, `just`, `easy`, `obviously`, `of course`, `note that`, `please
note`, and `in order to`. Cut praise such as `powerful`, `robust`, `seamless`, and
`comprehensive`. Use no emoji, exclamation marks, or rhetorical questions.

Length follows content. A one-line JSDoc is complete when the function is; a longer comment
earns its length by carrying a surprising reason rather than restating code or narrating a
change.

## Spelling and naming

Use American spelling in prose and comments: color, behavior, license, honored,
unrecognized. Identifiers follow the platform, including `color`, `colorScheme`, and
`stroke`. Write `shotlist` lowercase, including at the start of a sentence.
