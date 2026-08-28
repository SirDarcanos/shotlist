# Trust boundary

Trust is Operator state derived from CLI flags and environment controls. A Project may always narrow access. A trusted Project may approve Network destinations and environment names; an untrusted Project contributes no approvals. Work limits apply in every mode, and only Operator authority may change their numerical values.

## Guard every sink

Route every filesystem source and destination through `authorizePath`, then perform the effect on the canonical target it returns. Create every browser context through `guardedContext`, route shotlist-owned HTTP and TCP effects through the Node network adapter, and check site execution and stored browser state through `checkCommand` and `checkSession`. Adding a sink outside these modules bypasses policy even when adjacent callers are guarded.

`authorizePath` rejects secret-looking segments, control characters, forbidden extensions, and deny patterns in every mode. In untrusted mode it resolves existing symlink components and the nearest existing ancestor of a future path before confining the result to the Project root or Operator-granted roots.

`src/library.ts` owns policy-aware Library discovery. It authorizes every configured directory before enumeration and every discovered document before reading any document. Authorized targets stay inside the module; diagnostics retain authored paths, including paths that name symlinks.

Committed images and the Baseline are replaced through temporary siblings. Authorize the
source, destination, and exact generated sibling at effect time, perform every filesystem
effect on those canonical targets, and rename only after the sibling is complete. A failed
replacement removes the sibling rather than unlinking the prior committed file.

`src/network-policy.ts` owns Network destination parsing, approval merging, exact matching, sanitization, and bounded violation collection. A bare host means HTTPS port 443. HTTP and unusual ports require a full destination. A wildcard covers proper subdomains only. URL usernames and passwords are forbidden.

`src/network-playwright.ts` installs context routing before the first page, blocks service workers, and intercepts WebSockets separately. Check its latched violations before capturing pixels and before writing the Output image. `src/network-node.ts` disables automatic redirects and authorizes each readiness hop before sending it. Policy failures bypass `optional` Steps and Recipe retries.

The Network destination policy is a fence rather than a network sandbox. It cannot stop DNS rebinding, a browser vulnerability, or traffic from a process started for a trusted Project. Run hostile Projects in a container or runner whose network cannot reach metadata and internal services.

## Untrusted mode

An untrusted Run:

- starts no configured process
- loads no stored Session
- accepts no Project-provided Network destination or environment widening
- exposes only Operator-granted environment variables
- confines paths to approved real roots
- contacts only Operator-approved Network destinations

`deny`, `SHOTLIST_DENY`, and `SHOTLIST_ENV_DENY` only narrow policy and remain effective in every mode. `SHOTLIST_ALLOW` adds Operator-controlled Network destination approvals for protected CI settings. `SHOTLIST_WORK_LIMITS` changes numerical Work limits from protected process settings; a Project config has no equivalent control.

## Commands and environment

Managed site commands run directly with `shell: false`. Reject inline assignments, redirections, pipes, chaining, substitution, and backticks; put environment under `serve.env` and shell behavior in a Project-owned script. A trusted command remains arbitrary executable code, which is why command execution is disabled for untrusted Projects.

`envFor` exposes only granted names and omits empty values. Never print an environment value in errors or login guidance; name the variable needed rather than the secret it holds.

## Sessions

Session storage contains credentials. Untrusted Runs cannot load it. Trusted login retains cookies for the site host and configured `keep` hosts, and retains local storage for those origins. Network destination approval and credential retention remain separate: `site.allow` does not retain credentials, and Session `keep` does not grant network access.

When narrowing drops state and `verify` exists, load the narrowed state into a fresh guarded context and verify it before writing. Force mode `0600` on the final file so a successful login cannot leave credentials world-readable.
