import type { Rect } from './query.js'

export type Place = 'left' | 'right' | 'top' | 'bottom' | 'corner' | 'auto'
/** The sides a label can actually be drawn on, once `auto` has been decided. */
export type Side = 'left' | 'right' | 'top' | 'bottom'
/** Eight anchor points on a box: the corners, and the middle of each edge. */
export type Badge = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br'

/** One thing to draw: a box, and optionally a label or a numbered disc pointing at it. */
export interface Mark {
  rect: Rect
  /** One line, or several. */
  text?: string | string[]
  n?: number
  place: Place
  badge: Badge
  box: boolean
  /**
   * Whether the label or disc sits over the screenshot. Outside means in a margin the
   * canvas grows to make, which never covers the interface but costs width; inside keeps
   * the shot its own size and is what suits a mark with empty space beside it.
   *
   * Unset, a disc goes inside and a label on a named side goes outside — and one on
   * `place: auto` goes wherever the shot has room for it.
   */
  inside?: boolean
  /** Nudge, in image pixels, for what geometry alone cannot place. */
  dx?: number
  dy?: number
  pad?: number
  gap?: number
}

/** The drawing constants, already resolved from config. Sizes are in image pixels. */
export interface DrawStyle {
  color: string
  canvas: string
  box: { width: number; radius: number; pad: number }
  arrow: { shaft: number; headHalf: number; headLength: number }
  label: {
    font: string
    weight: number | string
    size: number
    fill: string
    stroke?: string
    strokeWidth: number
    gap: number
  }
  number: { radius: number; size: number; fill?: string; text: string }
  mask: { fill: string }
}

export interface AnnotationSpec {
  /** The screenshot's size in CSS pixels, which is its pixel size divided by `scale`. */
  image: { width: number; height: number }
  scale: number
  style: DrawStyle
  /** Rects are relative to the image's top-left corner, in CSS pixels. */
  marks: Mark[]
  /** Regions to paint over before anything is drawn, in the same coordinates. */
  masks?: Rect[]
}

/**
 * Draw the callouts, inside the page.
 *
 * Serialized into the browser, so it closes over nothing and imports nothing — which is
 * what lets it be unit-tested in jsdom.
 *
 * A label sits in a margin outside the screenshot with an arrow reaching in, or over the
 * shot when the recipe asks for it. Outside never covers the interface but costs width;
 * inside suits a mark with empty space beside it. Margins are measured from the labels
 * that need them, so the canvas grows only as far as it must.
 */
export function drawAnnotations(spec: AnnotationSpec): {
  width: number
  height: number
  /**
   * How far the shot sits from the canvas's top-left, once labels have claimed their
   * margins. A caller holding a rect in image coordinates needs this to find it again
   * in the finished picture.
   */
  margin: { left: number; top: number }
  /** Set when no family named in `label.font` was available and the default was used. */
  fontWarning?: string
} {
  const SVG = 'http://www.w3.org/2000/svg'
  const { image, scale, style, marks } = spec

  // Style sizes are image pixels; the page draws in CSS pixels at `scale` device pixels
  // each, so one image pixel is 1/scale of a CSS pixel.
  const k = 1 / scale
  const px = (value: number) => value * k

  const el = <T extends Element>(name: string, attrs: Record<string, string | number>): T => {
    const node = document.createElementNS(SVG, name)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    return node as unknown as T
  }

  document.getElementById('shotlist-layer')?.remove()

  const svg = el<SVGSVGElement>('svg', { id: 'shotlist-layer' })
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible'
  document.body.append(svg)

  const labelAttrs = {
    'font-family': style.label.font,
    'font-weight': String(style.label.weight),
    'font-size': px(style.label.size),
    fill: style.label.fill,
    stroke: style.label.stroke ?? style.color,
    'stroke-width': px(style.label.strokeWidth),
    'paint-order': 'stroke fill',
    'stroke-linejoin': 'round',
  }

  /**
   * Whether any family named was available.
   *
   * A font stack is an ordered list of acceptable choices, so an entry that does not
   * resolve is the stack working rather than a fault — a cross-platform one names Segoe
   * UI and Roboto knowing most machines have neither. What is worth reporting is none of
   * them resolving, because then every label is set in whatever the browser defaults to
   * and nothing says so. `document.fonts.check()` cannot tell: it answers true for a
   * family that does not exist. Measuring can.
   */
  const fontInUse = (): string | undefined => {
    // At the label's own weight: a webfont is usually declared at one weight, and a face
    // that only exists at 700 does not resolve for a probe asking at 400 — so the family
    // would read as missing on exactly the fonts a project goes to the trouble of loading.
    const probe = (family: string) => {
      const node = el<SVGTextElement>('text', {
        'font-family': family,
        'font-weight': String(style.label.weight),
        'font-size': 22,
      })
      node.textContent = 'Handgloves 0123'
      svg.append(node)
      const width = node.getBBox().width
      node.remove()
      return width
    }
    const fallback = probe('"shotlist no such family"')
    // The keywords meaning "whatever this platform has" are not faces to look for.
    const generic =
      /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|ui-[\w-]+)$/
    const named = style.label.font
      .split(',')
      .map((part) => part.trim())
      .filter((part) => !generic.test(part))
    if (named.length === 0) return undefined
    if (named.some((family) => probe(family) !== fallback)) return undefined
    return `label.font names ${named.join(', ')}, and none of them is available here; the browser's default was used`
  }
  const fontWarning = fontInUse()

  /**
   * How far the alphabetic baseline sits below the y a label is drawn at.
   *
   * Labels are positioned from a hanging baseline; canvas metrics are given against the
   * alphabetic one. This is the distance between them, which is a property of the face
   * and its size, so it is measured once.
   */
  const probeBaselineOffset = (() => {
    let cached: number | undefined
    return () => {
      if (cached !== undefined) return cached
      const shape = (baseline: string | null) => {
        const node = el<SVGTextElement>('text', { ...labelAttrs, x: 0, y: 0 })
        if (baseline) node.setAttribute('dominant-baseline', baseline)
        node.textContent = 'Handgloves'
        svg.append(node)
        const y = node.getBBox().y
        node.remove()
        return y
      }
      cached = shape('hanging') - shape(null)
      return cached
    }
  })()

  // Measure every label before deciding the margins: how far the canvas has to grow on a
  // side is the widest label placed there.
  const labeled = marks.filter((mark) => mark.text !== undefined && mark.place !== 'corner')
  const linesOf = (mark: Mark) => (Array.isArray(mark.text) ? mark.text : [mark.text!])
  const sizes = new Map<Mark, { width: number; height: number; leading: number; center: number }>()
  for (const mark of labeled) {
    let width = 0
    let line = 0
    // Where the glyphs actually sit, which getBBox cannot say: it reports the font's
    // metric box, identical for every line whatever its letters. A canvas can, and the
    // difference matters — a line with a cap and a descender inks half again as tall as
    // one with neither, and centring on the metric box puts an arrow inside the first
    // line rather than between them.
    const middles: number[] = []
    for (const text of linesOf(mark)) {
      // The same baseline the label is drawn with. Measured against the default one, the
      // ink offset is off by most of a line, and the arrow with it.
      const probe = el<SVGTextElement>('text', {
        ...labelAttrs,
        x: 0,
        y: 0,
        'dominant-baseline': 'hanging',
      })
      probe.textContent = text
      svg.append(probe)
      const box = probe.getBBox()
      width = Math.max(width, box.width)
      line = Math.max(line, box.height)
      middles.push(box.y + box.height / 2)
      probe.remove()
    }
    const leading = line * 1.25

    // The first line's ink, measured on a canvas, positioned in the middle of the stack.
    // Without a canvas — under jsdom — the metric box is all there is, and its middle is
    // the same answer to within a pixel or two.
    const inked = (() => {
      const context = document.createElement('canvas').getContext('2d')
      if (!context) return undefined
      context.font = `${style.label.weight} ${px(style.label.size)}px ${style.label.font}`
      const first = context.measureText(linesOf(mark)[0] ?? '')
      if (typeof first.actualBoundingBoxAscent !== 'number') return undefined
      // Relative to the alphabetic baseline, which sits this far below the anchor the
      // label is drawn from.
      const baseline = probeBaselineOffset()
      return baseline + (first.actualBoundingBoxDescent - first.actualBoundingBoxAscent) / 2
    })()

    const center =
      inked !== undefined
        ? inked + ((middles.length - 1) * leading) / 2
        : middles.reduce((sum, mid, index) => sum + mid + index * leading, 0) / middles.length
    sizes.set(mark, {
      width,
      height: leading * (linesOf(mark).length - 1) + line,
      leading,
      center,
    })
  }

  /** A mark's box before the margins are known, in image coordinates. */
  const rawBox = (mark: Mark) => {
    const pad = px(mark.pad ?? style.box.pad)
    return {
      left: mark.rect.x - pad,
      top: mark.rect.y - pad,
      right: mark.rect.x + mark.rect.width + pad,
      bottom: mark.rect.y + mark.rect.height + pad,
    }
  }

  /**
   * How much of a region of the shot is not blank, as a fraction of what was sampled.
   *
   * A label may sit over the screenshot instead of in a margin, which costs no canvas at
   * all — but only where it would cover nothing. Marks and masks say where the things
   * the recipe named are; this is the only way to ask about the rest.
   *
   * Null when the pixels cannot be read: jsdom has no 2D context, and a shot drawn from
   * a `source: file` recipe may be tainted. Placement then falls back to the geometry.
   */
  const inkIn = (() => {
    const shot = document.getElementById('shotlist-image') as HTMLImageElement | null
    if (!shot?.naturalWidth) return null
    let data: ImageData
    try {
      const sheet = document.createElement('canvas')
      sheet.width = shot.naturalWidth
      sheet.height = shot.naturalHeight
      const context = sheet.getContext('2d')
      if (!context) return null
      context.drawImage(shot, 0, 0)
      data = context.getImageData(0, 0, sheet.width, sheet.height)
    } catch {
      return null
    }
    // The shot is drawn at `scale` device pixels per CSS pixel; rects here are CSS.
    const grid = (rect: { left: number; top: number; right: number; bottom: number }) => {
      const step = Math.max(1, Math.round(scale * 2))
      const x0 = Math.max(0, Math.round(rect.left * scale))
      const y0 = Math.max(0, Math.round(rect.top * scale))
      const x1 = Math.min(data.width, Math.round(rect.right * scale))
      const y1 = Math.min(data.height, Math.round(rect.bottom * scale))
      const points: number[][] = []
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * data.width + x) * 4
          points.push([data.data[i]!, data.data[i + 1]!, data.data[i + 2]!])
        }
      }
      return points
    }
    return (rect: { left: number; top: number; right: number; bottom: number }) => {
      const points = grid(rect)
      if (points.length < 4) return 0
      // Against the region's own average, so a gradient or a tinted panel reads as empty
      // while text over either does not.
      const mean = [0, 1, 2].map(
        (channel) => points.reduce((sum, p) => sum + p[channel]!, 0) / points.length,
      )
      const off = points.filter((p) =>
        p.some((value, channel) => Math.abs(value - mean[channel]!) > 40),
      ).length
      return off / points.length
    }
  })()

  /**
   * Which side an `auto` label goes on.
   *
   * Two things decide it. A label on the left or the right grows the canvas by its
   * *width*, one above or below by its *height* — on a wide shot that is a difference of
   * several hundred pixels, and the widest label on a side sets the margin for all of
   * them. And the arrow runs from the margin to the box, so a side whose path crosses
   * something the recipe already pointed at, or masked, is one to avoid.
   *
   * What it cannot know is which of the *unmarked* pixels matter. `place:` is still
   * there for that, and still beats this.
   */
  const SIDES: Side[] = ['bottom', 'top', 'right', 'left']
  const chosen = new Map<Mark, { side: Side; inside: boolean }>()
  const taken: Record<Side, { from: number; to: number; size: number }[]> = {
    left: [],
    right: [],
    top: [],
    bottom: [],
  }

  /** Boxes an arrow should not be drawn across: everything called out, and every mask. */
  const obstacles = (self: Mark) => [
    ...marks.filter((mark) => mark !== self).map(rawBox),
    ...(spec.masks ?? []).map((rect) => ({
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    })),
  ]

  const overlaps = (
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number },
  ) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

  /** Remember what a label claimed, so the next one pays for having to clear it. */
  const claim = (mark: Mark, side: Side) => {
    const b = rawBox(mark)
    const size = sizes.get(mark)!
    const across = side === 'left' || side === 'right'
    taken[side].push({
      from: across ? b.top : b.left,
      to: across ? b.bottom : b.right,
      size: across ? size.width : size.height,
    })
  }

  for (const mark of labeled) {
    if (mark.place !== 'auto') {
      if (!(mark.inside ?? false)) claim(mark, mark.place as Side)
      continue
    }
    const b = rawBox(mark)
    const size = sizes.get(mark)!
    const gap = px(mark.gap ?? style.label.gap)
    const blockers = obstacles(mark)

    let best = { side: 'right' as Side, inside: false }
    let bestScore = Infinity
    for (const side of SIDES) {
      const across = side === 'left' || side === 'right'
      const middle = across ? (b.top + b.bottom) / 2 : (b.left + b.right) / 2
      const grows = across ? size.width : size.height
      const room =
        side === 'left'
          ? b.left
          : side === 'right'
            ? image.width - b.right
            : side === 'top'
              ? b.top
              : image.height - b.bottom

      // The strip the arrow travels down, from the edge of the shot to the box.
      const corridor =
        side === 'left'
          ? { left: 0, right: b.left, top: b.top, bottom: b.bottom }
          : side === 'right'
            ? { left: b.right, right: image.width, top: b.top, bottom: b.bottom }
            : side === 'top'
              ? { left: b.left, right: b.right, top: 0, bottom: b.top }
              : { left: b.left, right: b.right, top: b.bottom, bottom: image.height }
      const crossed = blockers.filter((o) => overlaps(o, corridor)).length

      // Outside: in a margin the canvas grows to make, with the arrow reaching in from
      // the edge of the shot however far that is.
      const from = across ? b.top : b.left
      const to = across ? b.bottom : b.right
      const stacked = taken[side]
        .filter((other) => other.from < to && other.to > from)
        .reduce((sum, other) => sum + other.size, 0)
      const outside = crossed * 100000 + grows + stacked + room * 0.5
      if (outside < bestScore) {
        bestScore = outside
        best = { side, inside: false }
      }

      // Inside: no canvas at all and an arrow only a gap long, but it covers part of the
      // shot — so it is only worth scoring where the shot has nothing there.
      if (inkIn === null || room < grows + gap * 2) continue
      const half = (across ? size.height : size.width) / 2
      const box = across
        ? {
            left: side === 'left' ? b.left - gap - size.width : b.right + gap,
            right: side === 'left' ? b.left - gap : b.right + gap + size.width,
            top: middle - half,
            bottom: middle + half,
          }
        : {
            left: middle - half,
            right: middle + half,
            top: side === 'top' ? b.top - gap - size.height : b.bottom + gap,
            bottom: side === 'top' ? b.top - gap : b.bottom + gap + size.height,
          }
      if (blockers.some((o) => overlaps(o, box))) continue
      const inside = inkIn(box) * 400000 + gap * 0.5
      if (inside < bestScore) {
        bestScore = inside
        best = { side, inside: true }
      }
    }
    chosen.set(mark, best)
    if (!best.inside) claim(mark, best.side)
  }

  /** The side a label is drawn on: the recipe's, or the one `auto` settled on. */
  const sideOf = (mark: Mark): Side => chosen.get(mark)?.side ?? (mark.place as Side)

  /**
   * Whether a label sits over the shot. What the recipe said, or — unsaid — a disc goes
   * inside, a label on a named side goes outside, and `auto` goes where there is room.
   */
  const insideOf = (mark: Mark): boolean =>
    mark.inside ?? chosen.get(mark)?.inside ?? mark.place === 'corner'

  // Only a label placed outside claims a margin; one placed inside sits over the shot.
  const margin = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const mark of labeled) {
    if (insideOf(mark)) continue
    const size = sizes.get(mark)!
    const gap = px(mark.gap ?? style.label.gap)
    const side = sideOf(mark)
    const need = side === 'left' || side === 'right' ? size.width + gap * 2 : size.height + gap * 2
    margin[side] = Math.max(margin[side], need)

    // And on the other axis, where the label is centered on its mark: one longer than the
    // room beside it overhangs the shot, and without a margin to overhang into it is slid
    // back against the edge with half its outline off the canvas.
    const b = rawBox(mark)
    const ink = px(style.label.strokeWidth) / 2
    if (side === 'left' || side === 'right') {
      // The same anchor the label is actually placed at, or the room reserved is not the
      // room used and a label beside a mark near the edge overhangs anyway.
      const top = (b.top + b.bottom) / 2 - size.center
      margin.top = Math.max(margin.top, -top + ink)
      margin.bottom = Math.max(margin.bottom, top + size.height - image.height + ink)
    } else {
      const center = (b.left + b.right) / 2
      margin.left = Math.max(margin.left, size.width / 2 - center + ink)
      margin.right = Math.max(margin.right, center + size.width / 2 - image.width + ink)
    }
  }

  /**
   * Where a disc sits on a box.
   *
   * One of eight anchors, pushed clear of the edge when `inside` is off — which is how a
   * disc ends up in a margin beside a full-width section rather than on top of it.
   */
  const anchorOf = (
    mark: Mark,
    b: { left: number; top: number; right: number; bottom: number },
  ) => {
    const out = insideOf(mark) ? 0 : px(style.number.radius)
    const x = mark.badge.endsWith('l')
      ? b.left - out
      : mark.badge.endsWith('r')
        ? b.right + out
        : (b.left + b.right) / 2
    const y = mark.badge.startsWith('t')
      ? b.top - out
      : mark.badge.startsWith('b')
        ? b.bottom + out
        : (b.top + b.bottom) / 2
    return { x: x + px(mark.dx ?? 0), y: y + px(mark.dy ?? 0) }
  }

  // A box drawn on an element that reaches the edge of the shot would have half its
  // stroke outside the canvas, and a disc on that box's corner would be sliced in two.
  // The canvas grows for them exactly as it grows for a label.
  const stroke = px(style.box.width) / 2
  for (const mark of marks) {
    const b = rawBox(mark)
    const edges = [
      {
        left: b.left - stroke,
        top: b.top - stroke,
        right: b.right + stroke,
        bottom: b.bottom + stroke,
      },
    ]
    if (mark.place === 'corner' && mark.n !== undefined) {
      const r = px(style.number.radius)
      const at = anchorOf(mark, b)
      edges.push({ left: at.x - r, top: at.y - r, right: at.x + r, bottom: at.y + r })
    }
    for (const edge of edges) {
      margin.left = Math.max(margin.left, -edge.left)
      margin.top = Math.max(margin.top, -edge.top)
      margin.right = Math.max(margin.right, edge.right - image.width)
      margin.bottom = Math.max(margin.bottom, edge.bottom - image.height)
    }
  }

  // Whole CSS pixels, so the screenshot's clip lands on whole device pixels at any
  // scale. A fractional canvas is silently rounded by the screenshot and the image comes
  // back a pixel narrower than the layout said.
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    margin[side] = Math.ceil(margin[side])
  }
  const canvas = {
    width: Math.ceil(image.width + margin.left + margin.right),
    height: Math.ceil(image.height + margin.top + margin.bottom),
  }

  const shot = document.getElementById('shotlist-image')
  if (shot) {
    shot.style.position = 'absolute'
    shot.style.left = `${margin.left}px`
    shot.style.top = `${margin.top}px`
    shot.style.width = `${image.width}px`
    shot.style.height = `${image.height}px`
  }
  document.body.style.margin = '0'
  document.body.style.background = style.canvas
  document.body.style.width = `${canvas.width}px`
  document.body.style.height = `${canvas.height}px`
  svg.setAttribute('width', String(canvas.width))
  svg.setAttribute('height', String(canvas.height))

  /** A mark's box on the canvas: the same box, moved by the margins. */
  const boxOf = (mark: Mark) => {
    const b = rawBox(mark)
    return {
      left: b.left + margin.left,
      top: b.top + margin.top,
      right: b.right + margin.left,
      bottom: b.bottom + margin.top,
    }
  }

  // Masks first, so a callout drawn over one is still legible. A mask never grows the
  // canvas: it covers part of the shot, so it is always inside it already.
  for (const rect of spec.masks ?? []) {
    svg.append(
      el('rect', {
        x: rect.x + margin.left,
        y: rect.y + margin.top,
        width: rect.width,
        height: rect.height,
        fill: style.mask.fill,
      }),
    )
  }

  for (const mark of marks) {
    if (!mark.box) continue
    const b = boxOf(mark)
    svg.append(
      el('rect', {
        x: b.left,
        y: b.top,
        width: b.right - b.left,
        height: b.bottom - b.top,
        rx: px(style.box.radius),
        fill: 'none',
        stroke: style.color,
        'stroke-width': px(style.box.width),
      }),
    )
  }

  /** A filled disc with a numeral, for a callout keyed to a numbered list in the prose. */
  const disc = (x: number, y: number, n: number) => {
    const r = px(style.number.radius)
    svg.append(el('circle', { cx: x, cy: y, r, fill: style.number.fill ?? style.color }))
    const text = el<SVGTextElement>('text', {
      x,
      y,
      fill: style.number.text,
      'font-family': style.label.font,
      'font-weight': String(style.label.weight),
      'font-size': px(style.number.size),
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
    })
    text.textContent = String(n)
    svg.append(text)
  }

  for (const mark of marks) {
    if (mark.place !== 'corner' || mark.n === undefined) continue
    const at = anchorOf(mark, boxOf(mark))
    disc(at.x, at.y, mark.n)
  }

  // Everything already drawn that a label placed over the shot must not land on: the
  // boxes, and each label as it is positioned.
  const occupied: Array<{ x: number; y: number; w: number; h: number; owner?: Mark }> = marks
    .filter((mark) => mark.box)
    .map((mark) => {
      const b = boxOf(mark)
      return { x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top, owner: mark }
    })

  type Span = { x: number; y: number; w: number; h: number }
  /** Whether two rects touch, counting anything within 8 image pixels as touching. */
  const collides = (a: Span, b: Span) => {
    const near = px(8)
    return (
      a.x < b.x + b.w + near &&
      a.x + a.w + near > b.x &&
      a.y < b.y + b.h + near &&
      a.y + a.h + near > b.y
    )
  }

  // Labels in a margin are laid out per side, in the order they were written, and pushed
  // along the margin so two never overlap.
  const used: Record<string, Array<{ from: number; to: number }>> = {
    left: [],
    right: [],
    top: [],
    bottom: [],
  }
  /** The nearest free run of `length` starting at `wanted`, along one margin. */
  const slot = (side: string, wanted: number, length: number, limit: number) => {
    let start = Math.min(Math.max(wanted, 0), Math.max(limit - length, 0))
    for (let guard = 0; guard < 64; guard++) {
      const clash = used[side]!.find((s) => start < s.to && start + length > s.from)
      if (!clash) break
      start = clash.to + px(8)
    }
    used[side]!.push({ from: start, to: start + length })
    return start
  }

  const arrow = (tail: { x: number; y: number }, tip: { x: number; y: number }) => {
    const dx = tip.x - tail.x
    const dy = tip.y - tail.y
    const length = Math.hypot(dx, dy) || 1
    const ux = dx / length
    const uy = dy / length
    const nx = -uy
    const ny = ux
    const shaft = px(style.arrow.shaft)
    const half = px(style.arrow.headHalf)
    const head = Math.min(px(style.arrow.headLength), length)
    const at = (along: number, across: number) => [
      tip.x - along * ux + across * nx,
      tip.y - along * uy + across * ny,
    ]
    const points = [
      at(0, 0),
      at(head, half),
      at(head, shaft),
      [tail.x + shaft * nx, tail.y + shaft * ny],
      [tail.x - shaft * nx, tail.y - shaft * ny],
      at(head, -shaft),
      at(head, -half),
    ]
    svg.append(
      el('polygon', {
        points: points.map(([x, y]) => `${x},${y}`).join(' '),
        fill: style.color,
      }),
    )
  }

  for (const mark of labeled) {
    const size = sizes.get(mark)!
    const gap = px(mark.gap ?? style.label.gap)
    const b = boxOf(mark)
    let side = sideOf(mark)

    const dx = px(mark.dx ?? 0)
    const dy = px(mark.dy ?? 0)
    let x: number
    let y: number
    if (insideOf(mark)) {
      // The glyph outline is painted outside the measured box, so the edge a label must
      // stay inside of is half a stroke in from the canvas.
      const edge = px(style.label.strokeWidth) / 2
      const hold = (value: number, max: number) =>
        Math.min(Math.max(value, edge), Math.max(max - edge, edge))

      // Flip to the far side when the near one has no room, rather than clamping the
      // label back over the mark it is naming.
      const room = {
        left: b.left,
        right: canvas.width - b.right,
        top: b.top,
        bottom: canvas.height - b.bottom,
      }
      const needs = side === 'left' || side === 'right' ? size.width + gap : size.height + gap
      let use = side
      if (room[use] < needs) {
        const flip = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[
          use
        ] as typeof use
        if (room[flip] >= needs) use = flip
      }
      side = use

      const wantX =
        side === 'left'
          ? b.left - gap - size.width
          : side === 'right'
            ? b.right + gap
            : (b.left + b.right) / 2 - size.width / 2
      // `size.center` for the same reason as the outside case below: the ink and the
      // metric box do not share a middle, and the arrow leaves from the ink.
      const wantY =
        side === 'top'
          ? b.top - gap - size.height
          : side === 'bottom'
            ? b.bottom + gap
            : (b.top + b.bottom) / 2 - size.center
      x = hold(wantX + dx, canvas.width - size.width)
      y = hold(wantY + dy, canvas.height - size.height)

      // Step clear of anything already drawn — along the axis the side does not fix, so
      // the label stays beside its own mark.
      const along = side === 'left' || side === 'right' ? 'y' : 'x'
      const stride = (along === 'y' ? size.height : size.width) + px(12)
      for (let tries = 0; tries < 24; tries++) {
        const here: Span = { x, y, w: size.width, h: size.height }
        const clash = occupied.find((other) => other.owner !== mark && collides(here, other))
        if (!clash) break
        if (along === 'y') y = hold(y + stride, canvas.height - size.height)
        else x = hold(x + stride, canvas.width - size.width)
      }
    } else if (side === 'left' || side === 'right') {
      // On `size.center`, not half the height: the first is where the label's ink sits,
      // the second where its metric box does, and they are not the same point. A line of
      // capitals with no descender inks well above the middle of the box the font
      // reserves for it, so centring the box left the words riding high and the arrow —
      // which starts at the ink and ends at the middle of the mark — running downhill.
      const wanted = (b.top + b.bottom) / 2 - size.center + dy
      y = slot(side, wanted, size.height, canvas.height)
      x =
        (side === 'left' ? margin.left - gap - size.width : canvas.width - margin.right + gap) + dx
    } else {
      const wanted = (b.left + b.right) / 2 - size.width / 2 + dx
      x = slot(side, wanted, size.width, canvas.width)
      y =
        (side === 'top' ? margin.top - gap - size.height : canvas.height - margin.bottom + gap) + dy
    }

    occupied.push({ x, y, w: size.width, h: size.height, owner: mark })

    linesOf(mark).forEach((line, index) => {
      const text = el<SVGTextElement>('text', {
        ...labelAttrs,
        x,
        y: y + index * size.leading,
        'dominant-baseline': 'hanging',
      })
      text.textContent = line
      svg.append(text)
    })

    // The outline is painted outside the box getBBox measures, so a tail starting at the
    // measured edge sits on top of it. Clear the stroke, then a little air.
    const clear = px(style.label.strokeWidth) / 2 + px(8)
    const middle = y + size.center
    const from =
      side === 'left'
        ? { x: x + size.width + clear, y: middle }
        : side === 'right'
          ? { x: x - clear, y: middle }
          : side === 'top'
            ? { x: x + size.width / 2, y: y + size.center + size.height / 2 + clear }
            : { x: x + size.width / 2, y: y + size.center - size.height / 2 - clear }
    // The middle of the edge it approaches. Following the label's own height instead
    // lands the head wherever the label happens to sit, which reads as an arrow that
    // missed — the reader is looking at the box, not at the words.
    const to =
      side === 'left'
        ? { x: b.left, y: (b.top + b.bottom) / 2 }
        : side === 'right'
          ? { x: b.right, y: (b.top + b.bottom) / 2 }
          : side === 'top'
            ? { x: (b.left + b.right) / 2, y: b.top }
            : { x: (b.left + b.right) / 2, y: b.bottom }

    const nudge = px(style.box.width)
    arrow(from, {
      x: to.x + (side === 'left' ? -nudge : side === 'right' ? nudge : 0),
      y: to.y + (side === 'top' ? -nudge : side === 'bottom' ? nudge : 0),
    })
  }

  const drawn = { ...canvas, margin: { left: margin.left, top: margin.top } }
  return fontWarning ? { ...drawn, fontWarning } : drawn
}
