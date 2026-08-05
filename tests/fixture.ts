import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Put the fixture page into jsdom and make `data-rect` the source of geometry.
 *
 * jsdom has no layout engine, so every rect would otherwise be zero. A real browser
 * ignores the attribute and measures the page for itself, which is what keeps the
 * same queries honest in both places.
 */
export function loadFixture(): void {
  const html = readFileSync(join(HERE, 'fixture/index.html'), 'utf8')
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)
  if (!body?.[1]) throw new Error('fixture has no body')
  document.body.innerHTML = body[1]

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const raw = this.getAttribute('data-rect')
    const [x = 0, y = 0, width = 0, height = 0] = raw ? raw.split(',').map(Number) : []
    return {
      x,
      y,
      width,
      height,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
      toJSON: () => ({}),
    } as DOMRect
  }
}

export const VIEWPORT = { width: 1000, height: 700 }
