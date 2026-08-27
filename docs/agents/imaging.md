# Image geometry and rendering

Keep geometry in one coordinate space until its owning boundary converts it. Most silent
image regressions are a rectangle translated twice, scaled early, or rounded by Chromium
rather than by shotlist.

## Coordinate spaces

DOM queries, clips, marks, masks, and annotation layout use CSS pixels. The browser context
applies `deviceScaleFactor`; ignore regions become final image pixels only after capture.

A frame query resolves inside the frame document. `src/step.ts` translates its rectangle
to top-page coordinates at the frame seam, including iframe border and padding. A
named outer-page `within` rectangle is invalid inside a frame because the documents do not
share coordinates.

A query clip is viewport-relative when resolved, while Playwright's full-page screenshot
clip is page-relative. Add `window.scrollY` when crossing that boundary, or a below-fold
clip silently captures the wrong viewport.

Marks, masks, and ignore regions become clip-relative exactly once. File-recipe dimensions
start in physical image pixels and are divided by recipe scale before entering CSS-pixel
annotation layout.

## Clip and annotation

`clipRect` supports `viewport`, `full`, and query-derived clips. Query clips floor their
origin, ceil their extent, clamp x and y to nonnegative values, and limit width to the
remaining viewport. Height remains free to extend below the viewport because tall captures
are valid.

`drawAnnotations` is self-contained so it can run through `page.evaluate` and under jsdom.
It draws in this order:

1. source image
2. masks
3. mark boxes
4. numbered discs
5. labels and arrows

Masks therefore hide source content without covering callouts.

Annotation style sizes describe final output pixels. The renderer multiplies them by
`1 / scale` in CSS space and lets Chromium device scaling restore the requested physical
stroke, font, gap, and radius. Round canvas dimensions and growth margins up to whole CSS
pixels, because fractional screenshot clips can change the encoded width silently.

Automatic placement scores canvas growth, occupied labels, arrow crossings, available
room, and sampled image ink. Preserve the geometry fallback when canvas pixels are
unavailable or tainted.

## Formats

PNG is the only intermediate format. Playwright capture and annotation remain lossless;
JPEG or WebP conversion happens once at the end in a Chromium canvas.

Verify the MIME returned by `toDataURL`. Chromium answers an unsupported encoding request
with PNG rather than an error, which otherwise writes valid PNG bytes under a false file
extension. `FORMATS` names only encoders proved by the Chromium test.

`src/image.ts` identifies PNG, JPEG, and WebP from signatures rather than extensions and
reads their dimensions from headers. Keep truncated-input failures explicit because file
recipes cross this boundary before the browser can diagnose them.

## Comparison

`src/check.ts` decodes the current and committed images in Chromium. Equal-size images
compare each RGBA channel against tolerance; the changed ratio is differing pixels divided
by total pixels, and a result changes only when `ratio > threshold`.

Ignore regions are resolved from the new page and painted identically over both images.
Their content is ignored, while movement or resizing remains visible at the old location.

Diff images are disposable PNG diagnostics. Equal-size inputs produce committed, current,
and highlighted-current panels; different dimensions produce two panels because an
overlay cannot align.

`src/baseline.ts` records the rendering environment rather than a committed image. Warn on
Playwright, Chromium, shotlist, or platform drift because rasterization can change while
the application does not.
