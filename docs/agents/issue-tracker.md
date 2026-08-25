# GitHub issue tracker

Issues and specifications live in this repository's GitHub Issues. Use `gh` inside the
clone so the Git remote selects the repository.

## Core operations

- Create: `gh issue create --title "..." --body-file -` with a heredoc on stdin.
- Read: `gh issue view <number> --comments` and include labels in structured reads.
- List: request `number,title,body,labels,comments` as JSON and apply state or label filters
  in the command rather than dropping issues after a narrow fetch.
- Comment: `gh issue comment <number> --body-file -`.
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

GitHub issues and pull requests share a number space. Resolve an ambiguous `#42` with
`gh pr view 42`, then fall back to `gh issue view 42`.

Pull requests are not a request surface for triage. Triage incoming issues; review pull
requests through the review workflow instead.

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to
fetch the relevant ticket, read the issue and its comments.

## Wayfinding

A wayfinder map is one issue labeled `wayfinder:map`. Its child tickets are GitHub
sub-issues labeled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or
`wayfinder:task`.

Represent blocking with GitHub issue dependencies. The dependency endpoint takes the
blocker's numeric database ID from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not
the issue number or GraphQL `node_id`.

The frontier is the map's first open child with no open blocker and no assignee. Claim it
with `gh issue edit <n> --add-assignee @me` as the session's first write. Resolve it by
commenting with the decision, closing the child, and linking that decision from the map.

When GitHub sub-issues or dependencies are unavailable, use a map task list, put
`Part of #<map>` on each child, and put `Blocked by: #<n>, ...` at the top of blocked
children. These text forms are fallbacks rather than a second source of truth.
