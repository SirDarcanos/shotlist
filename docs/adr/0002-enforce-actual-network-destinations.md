---
status: accepted
---

# Enforce actual Network destinations

shotlist checks every browser connection and shotlist-owned readiness probe against approved protocol, host, and port values because authored URLs do not reveal redirects, page subrequests, workers, or live connections. Trusted Projects may contribute approvals, while untrusted Projects contribute none; Operator authority remains effective in both modes.

## Consequences

Browser contexts block service workers and intercept requests and WebSockets before creating a page. Node readiness follows redirects manually and checks each hop. This breaks Projects that relied on undeclared destinations, but prevents shotlist from writing an Output image after the page contacted an unexpected destination. DNS behavior, browser vulnerabilities, and processes started by trusted Projects remain outside this fence, so hostile Projects still require an isolated runner.
