import type { Rect } from './query.js'

export type Place = 'left' | 'right' | 'top' | 'bottom' | 'corner'
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
   */
  inside: boolean
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
}

export interface AnnotationSpec {
  /** The screenshot's size in CSS pixels, which is its pixel size divided by `scale`. */
  image: { width: number; height: number }
  scale: number
  style: DrawStyle
  /** Rects are relative to the image's top-left corner, in CSS pixels. */
  marks: Mark[]
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
    const probe = (family: string) => {
      const node = el<SVGTextElement>('text', { 'font-family': family, 'font-size': 22 })
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

  // Measure every label before deciding the margins: how far the canvas has to grow on a
  // side is the widest label placed there.
  const labelled = marks.filter((mark) => mark.text !== undefined && mark.place !== 'corner')
  const linesOf = (mark: Mark) => (Array.isArray(mark.text) ? mark.text : [mark.text!])
  const sizes = new Map<Mark, { width: number; height: number; leading: number; inkTop: number }>()
  for (const mark of labelled) {
    let width = 0
    let line = 0
    // How far the glyphs sit from the y the text is positioned at. `hanging` is a
    // baseline, not the top of the ink, so an arrow aimed at the middle of the block
    // without this lands off-centre by that much.
    let inkTop = 0
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
      inkTop = box.y
      probe.remove()
    }
    const leading = line * 1.25
    sizes.set(mark, {
      width,
      height: leading * (linesOf(mark).length - 1) + line,
      leading,
      inkTop,
    })
  }

  // Only a label placed outside claims a margin; one placed inside sits over the shot.
  const margin = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const mark of labelled) {
    if (mark.inside) continue
    const size = sizes.get(mark)!
    const gap = px(mark.gap ?? style.label.gap)
    let side = mark.place as Exclude<Place, 'corner'>
    const need = side === 'left' || side === 'right' ? size.width + gap * 2 : size.height + gap * 2
    margin[side] = Math.max(margin[side], need)
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
   * Where a disc sits on a box.
   *
   * One of eight anchors, pushed clear of the edge when `inside` is off — which is how a
   * disc ends up in a margin beside a full-width section rather than on top of it.
   */
  const anchorOf = (
    mark: Mark,
    b: { left: number; top: number; right: number; bottom: number },
  ) => {
    const out = mark.inside ? 0 : px(style.number.radius)
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

  for (const mark of labelled) {
    const size = sizes.get(mark)!
    const gap = px(mark.gap ?? style.label.gap)
    const b = boxOf(mark)
    let side = mark.place as Exclude<Place, 'corner'>

    const dx = px(mark.dx ?? 0)
    const dy = px(mark.dy ?? 0)
    let x: number
    let y: number
    if (mark.inside) {
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
      const wantY =
        side === 'top'
          ? b.top - gap - size.height
          : side === 'bottom'
            ? b.bottom + gap
            : (b.top + b.bottom) / 2 - size.height / 2
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
      const wanted = (b.top + b.bottom) / 2 - size.height / 2 + dy
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
    const middle = y + size.inkTop + size.height / 2
    const from =
      side === 'left'
        ? { x: x + size.width + clear, y: middle }
        : side === 'right'
          ? { x: x - clear, y: middle }
          : side === 'top'
            ? { x: x + size.width / 2, y: y + size.inkTop + size.height + clear }
            : { x: x + size.width / 2, y: y + size.inkTop - clear }
    const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)
    const to =
      side === 'left'
        ? { x: b.left, y: clamp(from.y, b.top, b.bottom) }
        : side === 'right'
          ? { x: b.right, y: clamp(from.y, b.top, b.bottom) }
          : side === 'top'
            ? { x: clamp(from.x, b.left, b.right), y: b.top }
            : { x: clamp(from.x, b.left, b.right), y: b.bottom }

    const nudge = px(style.box.width)
    arrow(from, {
      x: to.x + (side === 'left' ? -nudge : side === 'right' ? nudge : 0),
      y: to.y + (side === 'top' ? -nudge : side === 'bottom' ? nudge : 0),
    })
  }

  return fontWarning ? { ...canvas, fontWarning } : canvas
}
