import type { Rect } from './query.js'

export type Place = 'left' | 'right' | 'top' | 'bottom' | 'corner'
export type Badge = 'tl' | 'tr' | 'bl' | 'br'

/** One thing to draw: a box, and optionally a label or a numbered disc pointing at it. */
export interface Mark {
  rect: Rect
  text?: string
  n?: number
  place: Place
  badge: Badge
  box: boolean
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
 * Labels are placed in a margin outside the screenshot with an arrow reaching in, never
 * over the image: a label that covers the interface hides the thing it is naming. The
 * margins are measured from the labels, so the canvas grows only as far as it must.
 */
export function drawAnnotations(spec: AnnotationSpec): { width: number; height: number } {
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

  // Measure every label before deciding the margins: how far the canvas has to grow on a
  // side is the widest label placed there.
  const labelled = marks.filter((mark) => mark.text !== undefined && mark.place !== 'corner')
  const sizes = new Map<Mark, { width: number; height: number }>()
  for (const mark of labelled) {
    const probe = el<SVGTextElement>('text', { ...labelAttrs, x: 0, y: 0 })
    probe.textContent = mark.text!
    svg.append(probe)
    const box = probe.getBBox()
    sizes.set(mark, { width: box.width, height: box.height })
    probe.remove()
  }

  const margin = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const mark of labelled) {
    const size = sizes.get(mark)!
    const gap = px(mark.gap ?? style.label.gap)
    const side = mark.place as Exclude<Place, 'corner'>
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
      const cx = mark.badge.includes('r') ? b.right : b.left
      const cy = mark.badge.startsWith('b') ? b.bottom : b.top
      edges.push({ left: cx - r, top: cy - r, right: cx + r, bottom: cy + r })
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
    const b = boxOf(mark)
    disc(
      mark.badge.includes('r') ? b.right : b.left,
      mark.badge.startsWith('b') ? b.bottom : b.top,
      mark.n,
    )
  }

  // Labels are laid out per side, in the order they were written, and pushed along the
  // margin so two never overlap.
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
    const side = mark.place as Exclude<Place, 'corner'>

    let x: number
    let y: number
    if (side === 'left' || side === 'right') {
      const wanted = (b.top + b.bottom) / 2 - size.height / 2
      y = slot(side, wanted, size.height, canvas.height)
      x = side === 'left' ? margin.left - gap - size.width : canvas.width - margin.right + gap
    } else {
      const wanted = (b.left + b.right) / 2 - size.width / 2
      x = slot(side, wanted, size.width, canvas.width)
      y = side === 'top' ? margin.top - gap - size.height : canvas.height - margin.bottom + gap
    }

    const text = el<SVGTextElement>('text', {
      ...labelAttrs,
      x,
      y,
      'dominant-baseline': 'hanging',
    })
    text.textContent = mark.text!
    svg.append(text)

    const from =
      side === 'left'
        ? { x: x + size.width, y: y + size.height / 2 }
        : side === 'right'
          ? { x, y: y + size.height / 2 }
          : side === 'top'
            ? { x: x + size.width / 2, y: y + size.height }
            : { x: x + size.width / 2, y }
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

  return canvas
}
