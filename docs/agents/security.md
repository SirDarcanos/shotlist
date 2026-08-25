# Trust boundary

Trust is operator state derived from CLI flags and environment controls. A config may
always narrow access; it widens hosts or environment names only in trusted mode, because a
config cannot grant itself authority.

## Guard every sink

Route every filesystem source and destination through `checkPath`, every authored
navigation URL through `checkUrl`, site execution through `checkCommand`, and stored
browser state through `checkSession`. These calls are the security boundary; adding a new
sink without its check bypasses policy even when adjacent callers are guarded.

`checkPath` rejects secret-looking segments, control characters, forbidden extensions, and
deny patterns in every mode. In untrusted mode it resolves existing symlink components and
the nearest existing ancestor of a future path before confining the result to the config
root or operator-granted roots.

`checkUrl` accepts only HTTP(S) in untrusted mode, checks decoded path segments, and confines
hosts to the configured site relationship plus operator grants. It rejects obvious
localhost, private, link-local, and cloud metadata hosts.

The URL policy is a fence rather than a network sandbox. It cannot observe DNS resolving a
public hostname privately, and it does not validate every redirect or subresource started
by a loaded page. Run hostile input behind network isolation from metadata and internal
services.

## Untrusted mode

An untrusted run:

- starts no configured process
- loads no stored session
- ignores config-provided host and environment widening
- exposes only operator-granted environment variables
- confines paths to approved real roots
- accepts only approved HTTP(S) hosts

`deny`, `SHOTLIST_DENY`, and `SHOTLIST_ENV_DENY` only narrow policy and remain effective in
every mode.

## Commands and environment

Managed site commands run directly with `shell: false`. Reject inline assignments,
redirections, pipes, chaining, substitution, and backticks; put environment under
`serve.env` and shell behavior in a project-owned script. A trusted command remains
arbitrary executable code, which is why command execution is disabled wholesale for
untrusted configs.

`envFor` exposes only explicitly granted names and omits empty values. Never print an
environment value in errors or login guidance; name the variable needed rather than the
secret it holds.

## Sessions

Session storage contains credentials. Untrusted runs cannot load it. Trusted login narrows
cookies to domains covered by approved site hosts and local storage to directly covered
origins; configured `keep` hosts are an explicit credential-retention decision.

When narrowing drops state and `verify` exists, load the narrowed state into a fresh
context and verify it before writing. Force mode `0600` on the final file so a successful
login cannot leave credentials world-readable.
