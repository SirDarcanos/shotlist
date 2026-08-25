# Test strategy

Test behavior in the layer that owns its truth rather than mocking the boundary that can
break it.

## Layers

- **Node**: schemas, document loading, interpolation, trust, filesystem behavior, image
  headers, sessions, servers, baseline records, CLI output, and pure helpers.
- **jsdom**: serialized query and annotation algorithms with controlled geometry in
  `tests/query.test.ts` and `tests/annotate.test.ts`.
- **Chromium**: Playwright locators, frames, dialogs, cookies, fonts, screenshots, canvas
  encoding, and end-to-end capture.

Playwright is optional for consumers but required by browser-driven tests. Install it as
stated in `CONTRIBUTING.md` rather than turning it into a runtime dependency.

## Fixtures

`CONTRIBUTING.md` owns each fixture's purpose and maintenance invariants. Read its fixture
section before changing one, then place the behavior in the fixture whose existing role
matches rather than growing a second general-purpose page.

Keep fixtures neutral and product-independent. A new query primitive needs a fixture shape
that demonstrates the missing vocabulary rather than a query copied from a consuming site.

## Browser evidence

Test browser encoders against their returned MIME and bytes. Chromium can accept an
unsupported requested format while returning PNG, so a string-enum test cannot establish
format support.

## Completion

Use the gate and completion criteria in `CONTRIBUTING.md`; they own schema generation,
documentation updates, and the requirement to break counting, indexing, or measuring code
before trusting its test.
