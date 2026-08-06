// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { drawAnnotations } from '../src/annotate.js'
import type { DrawStyle, Mark } from '../src/annotate.js'

const STYLE: DrawStyle = {
  color: '#DC2626',
  canvas: '#FFFFFF',
  box: { width: 6, radius: 10, pad: 8 },
  arrow: { shaft: 6, headHalf: 19, headLength: 38 },
  label: {
    font: 'Arial',
    weight: 700,
    size: 44,
    fill: '#FFFFFF',
    stroke: '#DC2626',
    strokeWidth: 6,
    gap: 40,
  },
  number: { radius: 26, size: 40, text: '#FFFFFF' },
}

const IMAGE = { width: 400, height: 300 }

/** A mark over a rect in the middle of the image; overrides merge on top. */
function mark(over: Partial<Mark> = {}): Mark {
  return {
    rect: { x: 100, y: 100, width: 80, height: 20 },
    place: 'right',
    badge: 'tl',
    box: true,
    inside: false,
    ...over,
  }
}

/** Draw against a 400×300 image at 2×, the scale most captures use. */
function draw(marks: Mark[], scale = 2) {
  return drawAnnotations({ image: IMAGE, scale, style: STYLE, marks })
}

beforeEach(() => {
  document.body.innerHTML = '<img id="shotlist-image">'
  // jsdom has no layout, so a text node reports no size and every margin would be zero.
  ;(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (
    this: SVGElement,
  ) {
    const length = (this.textContent ?? '').length
    return { width: length * 10, height: 20 } as DOMRect
  }
})

describe('canvas', () => {
  it('is the image itself when nothing needs room outside it', () => {
    expect(draw([mark({ place: 'corner', inside: true })])).toEqual(IMAGE)
  })

  it('grows on the side a label is placed', () => {
    const canvas = draw([mark({ text: 'What they owe', place: 'right' })])
    expect(canvas.height).toBe(IMAGE.height)
    expect(canvas.width).toBeGreaterThan(IMAGE.width)
  })

  it('grows for a box drawn on an element that reaches the edge', () => {
    // Half the stroke and all of the padding would otherwise fall outside the shot.
    const canvas = draw([mark({ rect: { x: 0, y: 0, width: IMAGE.width, height: 40 } })])
    expect(canvas.width).toBeGreaterThan(IMAGE.width)
    expect(canvas.height).toBeGreaterThan(IMAGE.height - 1)
  })

  it('grows for a numbered disc sitting on a corner at the edge', () => {
    const plain = draw([mark({ rect: { x: 40, y: 40, width: 80, height: 20 } })])
    const disced = draw([
      mark({ rect: { x: 0, y: 0, width: 80, height: 20 }, place: 'corner', n: 1, inside: true }),
    ])
    expect(plain).toEqual(IMAGE)
    expect(disced.width).toBeGreaterThan(IMAGE.width)
  })
})

describe('placement', () => {
  it('keeps the canvas its own size when a label is placed inside', () => {
    // The point of `inside`: a mark with empty space beside it does not need the shot to
    // grow, and growing it would leave a band of dead canvas holding one line of text.
    const outside = draw([mark({ text: 'What they owe', place: 'right' })])
    const inside = draw([mark({ text: 'What they owe', place: 'right', inside: true })])
    expect(outside.width).toBeGreaterThan(IMAGE.width)
    expect(inside).toEqual(IMAGE)
  })

  it('clamps an inside label so it cannot leave the canvas', () => {
    draw([
      mark({ rect: { x: 380, y: 10, width: 20, height: 20 }, text: 'Long label', inside: true }),
    ])
    const text = document.querySelector('#shotlist-layer text')!
    expect(Number(text.getAttribute('x'))).toBeLessThanOrEqual(IMAGE.width)
    expect(Number(text.getAttribute('x'))).toBeGreaterThanOrEqual(0)
  })

  it('writes one line per entry when the label is a list', () => {
    draw([mark({ text: ['Drag to move', 'a combatant'], inside: true })])
    const lines = [...document.querySelectorAll('#shotlist-layer text')]
    expect(lines.map((l) => l.textContent)).toEqual(['Drag to move', 'a combatant'])
    expect(Number(lines[1]!.getAttribute('y'))).toBeGreaterThan(Number(lines[0]!.getAttribute('y')))
  })

  it('anchors a disc to any of the eight points on a box', () => {
    const at = (badge: Mark['badge']) => {
      document.body.innerHTML = '<img id="shotlist-image">'
      draw([mark({ place: 'corner', n: 1, badge, inside: true })])
      const circle = document.querySelector('#shotlist-layer circle')!
      return { x: Number(circle.getAttribute('cx')), y: Number(circle.getAttribute('cy')) }
    }
    expect(at('tc').x).toBeCloseTo((at('tl').x + at('tr').x) / 2)
    expect(at('ml').y).toBeCloseTo((at('tl').y + at('bl').y) / 2)
    expect(at('bc').y).toBeCloseTo(at('br').y)
  })

  it('pushes a disc clear of the box when it is placed outside', () => {
    document.body.innerHTML = '<img id="shotlist-image">'
    draw([mark({ place: 'corner', n: 1, badge: 'ml', inside: true })])
    const on = Number(document.querySelector('#shotlist-layer circle')!.getAttribute('cx'))
    document.body.innerHTML = '<img id="shotlist-image">'
    draw([mark({ place: 'corner', n: 1, badge: 'ml', inside: false })])
    const off = Number(document.querySelector('#shotlist-layer circle')!.getAttribute('cx'))
    expect(off).toBeLessThan(on)
  })

  it('moves a mark by its nudge', () => {
    document.body.innerHTML = '<img id="shotlist-image">'
    draw([mark({ place: 'corner', n: 1, inside: true })])
    const plain = Number(document.querySelector('#shotlist-layer circle')!.getAttribute('cy'))
    document.body.innerHTML = '<img id="shotlist-image">'
    draw([mark({ place: 'corner', n: 1, inside: true, dy: -70 })])
    const moved = Number(document.querySelector('#shotlist-layer circle')!.getAttribute('cy'))
    // Nudges are image pixels, so -70 of them is 35 CSS pixels at 2x.
    expect(plain - moved).toBeCloseTo(35)
  })
})

describe('drawing', () => {
  it('draws one outlined box per mark, and none for box: false', () => {
    draw([mark(), mark({ rect: { x: 200, y: 40, width: 20, height: 20 }, box: false })])
    const rects = document.querySelectorAll('#shotlist-layer rect')
    expect(rects).toHaveLength(1)
    expect(rects[0]!.getAttribute('stroke')).toBe('#DC2626')
    expect(rects[0]!.getAttribute('fill')).toBe('none')
  })

  it('writes a label as outlined text, not a filled pill', () => {
    draw([mark({ text: 'How many', place: 'left' })])
    const text = document.querySelector('#shotlist-layer text')!
    expect(text.textContent).toBe('How many')
    expect(text.getAttribute('fill')).toBe('#FFFFFF')
    expect(text.getAttribute('stroke')).toBe('#DC2626')
    expect(text.getAttribute('paint-order')).toBe('stroke fill')
    expect(document.querySelectorAll('#shotlist-layer polygon')).toHaveLength(1)
  })

  it('scales every drawing constant down by the device scale', () => {
    // Sizes are image pixels, so a 6px stroke is 3 CSS pixels at 2×.
    draw([mark()], 2)
    expect(document.querySelector('#shotlist-layer rect')!.getAttribute('stroke-width')).toBe('3')
    document.body.innerHTML = '<img id="shotlist-image">'
    draw([mark()], 1)
    expect(document.querySelector('#shotlist-layer rect')!.getAttribute('stroke-width')).toBe('6')
  })

  it('draws a disc with its numeral for a corner callout', () => {
    draw([mark({ place: 'corner', n: 3 })])
    expect(document.querySelectorAll('#shotlist-layer circle')).toHaveLength(1)
    expect(document.querySelector('#shotlist-layer text')!.textContent).toBe('3')
  })

  it('replaces a previous layer instead of stacking a second one', () => {
    draw([mark()])
    draw([mark()])
    expect(document.querySelectorAll('#shotlist-layer')).toHaveLength(1)
  })

  it('separates two labels placed on the same side', () => {
    draw([
      mark({ rect: { x: 100, y: 100, width: 80, height: 20 }, text: 'One', place: 'right' }),
      mark({ rect: { x: 100, y: 104, width: 80, height: 20 }, text: 'Two', place: 'right' }),
    ])
    const [first, second] = [...document.querySelectorAll('#shotlist-layer text')]
    expect(Number(second!.getAttribute('y'))).toBeGreaterThan(Number(first!.getAttribute('y')))
  })
})
