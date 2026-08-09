// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { drawAnnotations } from '../src/annotate.js'
import type { DrawStyle, Mark } from '../src/annotate.js'

// jsdom has no 2D context and logs a "Not implemented" error every time one is asked
// for — hundreds of them across this file, which makes a passing run read as a failing
// one. The drawing layer already treats a missing context as the ordinary jsdom case and
// falls back to metric boxes, so saying so outright is the same code path without the
// noise. A test that needs real pixel measurement belongs in the browser suite.
HTMLCanvasElement.prototype.getContext = () => null

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
  mask: { fill: '#94A3B8' },
}

const IMAGE = { width: 400, height: 300 }

/** A mark over a rect in the middle of the image; overrides merge on top. */
function mark(over: Partial<Mark> = {}): Mark {
  return {
    rect: { x: 100, y: 100, width: 80, height: 20 },
    place: 'right',
    badge: 'tl',
    box: true,
    ...over,
  }
}

/** Draw against a 400×300 image at 2×, the scale most captures use. */
function draw(
  marks: Mark[],
  scale = 2,
  masks?: { x: number; y: number; width: number; height: number }[],
) {
  return drawAnnotations({ image: IMAGE, scale, style: STYLE, marks, ...(masks ? { masks } : {}) })
}

/** Every rect the layer holds, as `x,y,width,height`, with its fill. */
function rects() {
  return [...document.querySelectorAll('#shotlist-layer rect')].map((node) => ({
    at: ['x', 'y', 'width', 'height'].map((key) => node.getAttribute(key)).join(','),
    fill: node.getAttribute('fill'),
  }))
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

  // The arrow leaves the label's ink and lands on the middle of the mark. Those are the
  // same height or the arrow slopes, which is what centring the label's metric box did:
  // a font reserves room for descenders whether or not a line has any.
  it('runs a side label’s arrow level with the mark it points at', () => {
    // Both paths: a label in a margin, and one sitting over the shot, which places
    // itself separately and had the same mistake.
    for (const place of ['left', 'right'] as const)
      for (const inside of [false, true]) {
        draw([mark({ text: 'Start here', place, inside })])
        const arrow = [...document.querySelectorAll('#shotlist-layer polygon')].at(-1)!
        const points = (arrow.getAttribute('points') ?? '')
          .split(' ')
          .map((pair) => pair.split(',').map(Number))
        // The tip, and the tail as the midpoint of the two corners behind it.
        const tip = points[0]!
        const tail = [(points[3]![0]! + points[4]![0]!) / 2, (points[3]![1]! + points[4]![1]!) / 2]
        expect(Math.abs(tail[1]! - tip[1]!), `${place}, inside ${inside}: slopes`).toBeLessThan(0.5)
      }
  })

  it('grows for a box drawn on an element that reaches the edge', () => {
    // Half the stroke and all of the padding would otherwise fall outside the shot.
    const canvas = draw([mark({ rect: { x: 0, y: 0, width: IMAGE.width, height: 40 } })])
    expect(canvas.width).toBeGreaterThan(IMAGE.width)
    expect(canvas.height).toBeGreaterThan(IMAGE.height - 1)
  })

  it('grows sideways for a label above a mark near the edge', () => {
    // A top label is centered on its mark, so one wider than the room beside it hangs off
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

  it('outlines a label in the callout color when no stroke is named', () => {
    expect(bare.label.stroke).toBeUndefined()
    drawAnnotations({
      image: IMAGE,
      scale: 2,
      style: bare as unknown as DrawStyle,
      marks: [mark({ text: 'a label', inside: true })],
    })
    expect(document.querySelector('#shotlist-layer text')!.getAttribute('stroke')).toBe(bare.color)
  })

  it('fills a disc with the callout color when no fill is named', () => {
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

// A shot can hold one thing the recipe does not decide — a clock, a live total. Without a
// mask the whole image has to give up `--check`, which is the check nobody then reads.
describe('masks', () => {
  const region = { x: 10, y: 20, width: 60, height: 30 }

  it('paints the region, before any callout is drawn over it', () => {
    draw([mark({ box: true, text: undefined })], 2, [region])
    const painted = rects()
    expect(painted[0]).toEqual({ at: '10,20,60,30', fill: STYLE.mask.fill })
    // The callout's own outline comes after, so it stays legible over a mask.
    expect(painted[1]?.fill).toBe('none')
  })

  it('draws over the shot without growing the canvas', () => {
    const plain = draw([], 2)
    const masked = draw([], 2, [region])
    expect(masked.width).toBe(plain.width)
    expect(masked.height).toBe(plain.height)
    expect(rects()).toHaveLength(1)
  })

  it('moves the region by the margin a label claimed', () => {
    // A label placed left grows the canvas on that side, and the shot moves with it —
    // a mask is in image coordinates, so it has to move by the same amount.
    draw([mark({ place: 'left', text: 'Some label' })], 2, [region])
    const [painted] = rects()
    const x = Number(painted!.at.split(',')[0])
    expect(x).toBeGreaterThan(region.x)
  })
})

// A label on the left or right grows the canvas by its width, one above or below by its
// height — and the arrow runs from the margin to the box, so a side whose path crosses
// something already pointed at is one to avoid. `place:` still beats all of it.
describe('place: auto', () => {
  /** Which side a label ended up on, read off the canvas it produced. */
  function side(result: { width: number; height: number; margin: { left: number; top: number } }) {
    const grewX = result.width - IMAGE.width
    const grewY = result.height - IMAGE.height
    if (grewX >= grewY) return result.margin.left > 0 ? 'left' : 'right'
    return result.margin.top > 0 ? 'top' : 'bottom'
  }

  const label = { text: 'What they owe', place: 'auto' } as const

  it('takes the cheap axis: a wide label costs its height, not its width', () => {
    // 13 characters wide against 20 tall, so beside the mark costs three times as much
    // canvas as above it. The nearer edge of the two settles which.
    expect(side(draw([mark(label)]))).toBe('top')
  })

  it('goes the other way rather than cross another mark', () => {
    const blocker = mark({ rect: { x: 100, y: 20, width: 80, height: 20 }, place: 'corner' })
    expect(side(draw([mark(label), blocker]))).toBe('bottom')
  })

  it('goes the other way rather than cross a mask', () => {
    expect(side(draw([mark(label)], 2, [{ x: 90, y: 10, width: 100, height: 40 }]))).toBe('bottom')
  })

  it('leaves a side the recipe named alone', () => {
    expect(side(draw([mark({ ...label, place: 'left' })]))).toBe('left')
    expect(side(draw([mark({ ...label, place: 'bottom' })]))).toBe('bottom')
  })

  it('spreads two labels that would otherwise stack on one side', () => {
    // Both marks are cheapest above, and their widths overlap — so the second would have
    // to clear the first. Paying for that is what sends it the other way instead.
    const together = draw([
      mark({ ...label, rect: { x: 100, y: 100, width: 80, height: 20 } }),
      mark({ ...label, rect: { x: 110, y: 140, width: 80, height: 20 } }),
    ])
    const grewAbove = together.margin.top
    const grewBelow = together.height - IMAGE.height - grewAbove
    expect(grewAbove).toBeGreaterThan(0)
    expect(grewBelow).toBeGreaterThan(0)
  })
})

// A label over the shot costs no canvas at all and needs only a stub of an arrow — but
// only where it would cover nothing, which marks and masks cannot say. The pixels can.
describe('place: auto, over the shot', () => {
  const real = HTMLCanvasElement.prototype.getContext

  /** Give the layer a shot to read: blank, or inked where `busy` says. */
  function shotOf(busy?: (x: number, y: number) => boolean) {
    const img = document.getElementById('shotlist-image')!
    for (const [key, value] of [
      ['naturalWidth', IMAGE.width * 2],
      ['naturalHeight', IMAGE.height * 2],
    ] as const) {
      Object.defineProperty(img, key, { value, configurable: true })
    }
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => {},
      // The label measurer asks the same kind of context for text metrics; without this
      // it falls over rather than falling back to the metric box as it does under jsdom.
      font: '',
      measureText: () => ({}),
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4).fill(255)
        if (busy) {
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              if (!busy(x, y)) continue
              const i = (y * width + x) * 4
              data[i] = 0
              data[i + 1] = 0
              data[i + 2] = 0
            }
          }
        }
        return { data, width, height }
      },
    })) as unknown as typeof real
  }

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = real
  })

  const label = { text: 'What they owe', place: 'auto' } as const

  it('goes over the shot where the shot has nothing there', () => {
    shotOf()
    // No margin at all: the label sits in the empty space beside its mark.
    expect(draw([mark(label)])).toMatchObject(IMAGE)
  })

  it('stays outside where it would cover something', () => {
    // Detail, not darkness: a region of one flat color has nothing to lose by being
    // covered, and it is the variation in it that says something is there.
    shotOf((x) => x % 6 < 2)
    const canvas = draw([mark(label)])
    expect(canvas.height).toBeGreaterThan(IMAGE.height)
  })

  it('still obeys a recipe that asked for one or the other', () => {
    shotOf()
    // Empty shot, so `auto` would go inside — but the callout said otherwise.
    expect(draw([mark({ ...label, inside: false })]).height).toBeGreaterThan(IMAGE.height)
  })
})
