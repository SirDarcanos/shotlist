// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
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
    // Different families measure differently, which is how the font check tells a family
    // that resolved from one that fell back. A stub that ignores the family would report
    // every font as missing.
    const family = this.getAttribute('font-family') ?? ''
    const per = /no such family|Nowhere|Neither/.test(family) ? 9 : 10
    // y is the ink top relative to the text's own y, which `hanging` puts above it.
    return { x: 0, y: -4, width: length * per, height: 20 } as DOMRect
  }
})

describe('canvas', () => {
  it('is the image itself when nothing needs room outside it', () => {
    expect(draw([mark({ place: 'corner', inside: true })])).toMatchObject(IMAGE)
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

  it('grows sideways for a label above a mark near the edge', () => {
    // A top label is centred on its mark, so one wider than the room beside it hangs off
    // the shot. Without this the label is slid back against the edge and shaved.
    const canvas = draw([
      mark({
        rect: { x: 360, y: 100, width: 20, height: 20 },
        text: 'Mark them surprised',
        place: 'top',
      }),
    ])
    expect(canvas.height).toBeGreaterThan(IMAGE.height)
    expect(canvas.width).toBeGreaterThan(IMAGE.width)
  })

  it('grows up and down for a label beside a mark at the top edge', () => {
    const canvas = draw([
      mark({ rect: { x: 100, y: 0, width: 80, height: 4 }, text: 'What they owe', place: 'right' }),
    ])
    expect(canvas.height).toBeGreaterThan(IMAGE.height)
  })

  it('grows for a numbered disc sitting on a corner at the edge', () => {
    const plain = draw([mark({ rect: { x: 40, y: 40, width: 80, height: 20 } })])
    const disced = draw([
      mark({ rect: { x: 0, y: 0, width: 80, height: 20 }, place: 'corner', n: 1, inside: true }),
    ])
    expect(plain).toMatchObject(IMAGE)
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
    expect(inside).toMatchObject(IMAGE)
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

/** Every label's box on the canvas, in the order they were drawn. */
function labelBoxes() {
  const seen = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const node of document.querySelectorAll('#shotlist-layer text')) {
    const text = node.textContent ?? ''
    if (/^\d+$/.test(text)) continue // a disc's numeral, not a label
    if (seen.has(text)) continue
    seen.set(text, {
      x: Number(node.getAttribute('x')),
      y: Number(node.getAttribute('y')),
      w: text.length * 10,
      h: 20,
    })
  }
  return [...seen.values()]
}

/** Whether two boxes overlap at all. */
function overlap(
  a: ReturnType<typeof labelBoxes>[number],
  b: ReturnType<typeof labelBoxes>[number],
) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

describe('appearance', () => {
  // These assert what a reader sees rather than what the DOM contains. Both defects they
  // pin shipped with sixteen passing structural tests behind them.
  it('does not let two labels placed over the shot overlap', () => {
    draw([
      mark({ rect: { x: 40, y: 100, width: 60, height: 20 }, text: 'first one', inside: true }),
      mark({ rect: { x: 40, y: 108, width: 60, height: 20 }, text: 'second one', inside: true }),
    ])
    const [a, b] = labelBoxes()
    expect(a && b).toBeTruthy()
    expect(overlap(a!, b!)).toBe(false)
  })

  it('keeps a label placed over the shot inside the canvas', () => {
    // Against the right edge: clamping has to account for the outline, which is painted
    // outside the measured text box.
    const canvas = draw([
      mark({ rect: { x: 360, y: 100, width: 30, height: 20 }, text: 'level', inside: true }),
    ])
    const [box] = labelBoxes()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.w).toBeLessThanOrEqual(canvas.width)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.h).toBeLessThanOrEqual(canvas.height)
  })

  it('flips to the far side when the near one has no room', () => {
    // The mark is hard against the right edge, so a label asked for the right has to go
    // left rather than be clamped back over the mark it is naming.
    draw([
      mark({ rect: { x: 370, y: 100, width: 30, height: 20 }, text: 'over here', inside: true }),
    ])
    const [box] = labelBoxes()
    expect(box!.x + box!.w).toBeLessThanOrEqual(370)
  })

  it('starts the arrow clear of the label, not on its outline', () => {
    // getBBox measures the fill, and the outline is painted outside it — a tail at the
    // measured edge sits on top of the stroke it should be clearing.
    draw([
      mark({ rect: { x: 260, y: 100, width: 60, height: 20 }, text: 'a label', place: 'left' }),
    ])
    const label = labelBoxes()[0]!
    const points = document
      .querySelector('#shotlist-layer polygon')!
      .getAttribute('points')!
      .split(' ')
      .map((pair) => Number(pair.split(',')[0]))
    // Placed left, the arrow runs rightward from the label, so every point is past it.
    expect(Math.min(...points)).toBeGreaterThan(label.x + label.w)
  })

  it('aims the arrow at the middle of the ink, not of the anchor box', () => {
    // Two lines are positioned from a hanging baseline; centring on the anchor without
    // the ink offset puts the arrow off by that offset.
    draw([
      mark({
        rect: { x: 40, y: 100, width: 60, height: 20 },
        text: ['first line', 'second line'],
        place: 'right',
      }),
    ])
    const texts = [...document.querySelectorAll('#shotlist-layer text')]
    const ys = texts.map((node) => Number(node.getAttribute('y')))
    const inkTop = -4 // what the stub reports
    const lineHeight = 20
    const leading = lineHeight * 1.25
    const wanted = ys[0]! + inkTop + (leading + lineHeight) / 2
    const points = document
      .querySelector('#shotlist-layer polygon')!
      .getAttribute('points')!
      .split(' ')
      .map((pair) => Number(pair.split(',')[1]))
    // The tail sits at that middle; the head is clamped into the box, so take the extreme.
    expect(Math.max(...points)).toBeGreaterThanOrEqual(wanted - 1)
    expect(Math.min(...points)).toBeLessThanOrEqual(wanted + 1)
  })

  it('points the arrow at the middle of the box, wherever the label sits', () => {
    // The head lands on the box's edge midpoint. Following the label's height instead
    // puts it wherever the label ended up, which reads as an arrow that missed.
    draw([
      mark({
        rect: { x: 40, y: 100, width: 60, height: 60 },
        text: 'a label',
        place: 'right',
        inside: true,
        dy: 120,
      }),
    ])
    const rect = document.querySelector('#shotlist-layer rect')!
    const boxMiddle = Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2
    // The polygon's first point is the tip.
    const tip = document
      .querySelector('#shotlist-layer polygon')!
      .getAttribute('points')!
      .split(' ')[0]!
      .split(',')
      .map(Number)
    expect(tip[1]).toBeCloseTo(boxMiddle, 1)
  })

  it('does not draw a label over another mark box', () => {
    draw([
      mark({ rect: { x: 200, y: 100, width: 60, height: 20 }, box: true }),
      mark({ rect: { x: 60, y: 100, width: 60, height: 20 }, text: 'a label', inside: true }),
    ])
    const rect = document.querySelector('#shotlist-layer rect')!
    const boxed = {
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      w: Number(rect.getAttribute('width')),
      h: Number(rect.getAttribute('height')),
    }
    const [label] = labelBoxes()
    expect(overlap(label!, boxed)).toBe(false)
  })
})

describe('style', () => {
  // The package's own defaults are what a project gets before it configures anything,
  // and no test had ever drawn with them.
  const bare = parseConfig({ site: { url: 'http://localhost' } }).style

  it('outlines a label in the callout colour when no stroke is named', () => {
    expect(bare.label.stroke).toBeUndefined()
    drawAnnotations({
      image: IMAGE,
      scale: 2,
      style: bare as unknown as DrawStyle,
      marks: [mark({ text: 'a label', inside: true })],
    })
    expect(document.querySelector('#shotlist-layer text')!.getAttribute('stroke')).toBe(bare.color)
  })

  it('fills a disc with the callout colour when no fill is named', () => {
    expect(bare.number.fill).toBeUndefined()
    drawAnnotations({
      image: IMAGE,
      scale: 2,
      style: bare as unknown as DrawStyle,
      marks: [mark({ place: 'corner', n: 1, inside: true })],
    })
    expect(document.querySelector('#shotlist-layer circle')!.getAttribute('fill')).toBe(bare.color)
  })

  it('draws every constant from the config it was given, not from a default', () => {
    const loud: DrawStyle = {
      ...STYLE,
      color: '#0000FF',
      box: { width: 2, radius: 0, pad: 20 },
      number: { radius: 10, size: 12, fill: '#00FF00', text: '#000000' },
    }
    drawAnnotations({
      image: IMAGE,
      scale: 2,
      style: loud,
      marks: [mark({ place: 'corner', n: 1, inside: true }), mark({ box: true })],
    })
    const rect = document.querySelector('#shotlist-layer rect')!
    expect(rect.getAttribute('stroke')).toBe('#0000FF')
    expect(rect.getAttribute('stroke-width')).toBe('1')
    expect(rect.getAttribute('rx')).toBe('0')
    expect(document.querySelector('#shotlist-layer circle')!.getAttribute('fill')).toBe('#00FF00')
  })
})

describe('fonts', () => {
  it('says nothing when the first family named is the one used', () => {
    const result = draw([mark({ text: 'a label', inside: true })])
    expect(result.fontWarning).toBeUndefined()
  })

  it('says nothing when a later family in the stack resolves', () => {
    // A stack is an ordered list of acceptable choices. A cross-platform one names Segoe
    // UI and Roboto knowing most machines have neither, and that is it working.
    const result = drawAnnotations({
      image: IMAGE,
      scale: 2,
      style: { ...STYLE, label: { ...STYLE.label, font: 'Nowhere, Arial' } },
      marks: [mark({ text: 'a label', inside: true })],
    })
    expect(result.fontWarning).toBeUndefined()
  })

  it('warns when none of the families named is available', () => {
    // Then every label is set in whatever the browser defaults to, and nothing says so.
    const result = drawAnnotations({
      image: IMAGE,
      scale: 2,
      style: { ...STYLE, label: { ...STYLE.label, font: 'Nowhere, Neither, sans-serif' } },
      marks: [mark({ text: 'a label', inside: true })],
    })
    expect(result.fontWarning).toMatch(/Nowhere, Neither.*none of them is available/)
  })

  it('ignores a generic family, which always resolves', () => {
    const result = drawAnnotations({
      image: IMAGE,
      scale: 2,
      style: { ...STYLE, label: { ...STYLE.label, font: 'sans-serif' } },
      marks: [mark({ text: 'a label', inside: true })],
    })
    expect(result.fontWarning).toBeUndefined()
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
