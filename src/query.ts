import { z } from 'zod'

/** A rectangle in CSS pixels, relative to the viewport. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const Dimension = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(px|vw|vh)$/)])

const Filters = z.object({
  contains: z.string().optional(),
  containingAll: z.array(z.string()).optional(),
  matching: z.string().optional(),
  text: z.string().optional(),
  maxChildren: z.int().nonnegative().optional(),
  minChildren: z.int().nonnegative().optional(),
  minWidth: Dimension.optional(),
  maxWidth: Dimension.optional(),
  minHeight: Dimension.optional(),
  maxHeight: Dimension.optional(),
  narrowerThan: Dimension.optional(),
  widerThan: Dimension.optional(),
  visible: z.boolean().optional(),
})

/**
 * Where to stop when climbing.
 *
 * `nearest` is the first ancestor that matches; `outermost` keeps climbing while the
 * parent still matches, which is what pulls a modal's card out of its full-screen
 * overlay rather than stopping at the first narrow element inside it.
 */
const Ancestor = Filters.extend({
  pick: z.enum(['nearest', 'outermost']).default('nearest'),
})

const Grow = z
  .object({
    top: z.number().optional(),
    right: z.number().optional(),
    bottom: z.number().optional(),
    left: z.number().optional(),
  })
  .strict()

/** One element query: where to look, what to keep, which one, and how to pad the result. */
export const ElementQuery = Filters.extend({
  // Sources. `role`/`label`/`placeholder`/`testid` resolve through Playwright's own
  // engine before the filters below run; `css` and `heading` resolve in the page.
  css: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testid: z.string().optional(),
  heading: z.string().optional(),
  exact: z.boolean().optional(),

  // Scope: the name of an already-resolved rect (a mark, or `clip`). Candidates must
  // sit geometrically inside it.
  within: z.string().optional(),

  // Traversal, applied in this order.
  ancestor: Ancestor.optional(),
  parent: z.boolean().optional(),
  child: z.int().nonnegative().optional(),
  children: z.boolean().optional(),

  pick: z.enum(['first', 'last', 'smallest', 'largest']).optional(),
  nth: z.int().nonnegative().optional(),

  pad: z.number().optional(),
  grow: Grow.optional(),
}).strict()

/** The bounding box of several queries at once — console.py's `span()`. */
export const SpanQuery = z
  .object({
    span: z.array(z.lazy(() => Query)),
    pad: z.number().optional(),
    grow: Grow.optional(),
  })
  .strict()

/** A literal box in image pixels, for a recipe annotating a PNG with no DOM to query. */
export const RectQuery = z
  .object({
    rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    pad: z.number().optional(),
    grow: Grow.optional(),
  })
  .strict()

export const Query: z.ZodType<QueryInput> = z.union([RectQuery, SpanQuery, ElementQuery])

export type ElementQueryInput = z.input<typeof ElementQuery>
export type QueryInput =
  | ElementQueryInput
  | { rect: [number, number, number, number]; pad?: number; grow?: z.infer<typeof Grow> }
  | { span: QueryInput[]; pad?: number; grow?: z.infer<typeof Grow> }

/** Every key `ElementQuery` understands — anything else in a one-key object is an alias call. */
export const QUERY_KEYS: ReadonlySet<string> = new Set(Object.keys(ElementQuery.shape))

/** Whether a node is an alias call like `{ trackerRow: "Zara" }` rather than a query. */
export function isAliasCall(node: unknown): node is Record<string, unknown> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
  const keys = Object.keys(node as object)
  return (
    keys.length === 1 && keys[0] !== undefined && !QUERY_KEYS.has(keys[0]) && keys[0] !== 'span'
  )
}

/** Replace `$1`, `$2`… in every string of a template with the alias call's arguments. */
export function substitute(template: unknown, args: readonly string[]): unknown {
  if (typeof template === 'string') {
    return template.replace(/\$(\d+)/g, (_whole, index: string) => {
      const value = args[Number(index) - 1]
      if (value === undefined) throw new Error(`no argument $${index} was given`)
      return value
    })
  }
  if (Array.isArray(template)) return template.map((item) => substitute(item, args))
  if (typeof template === 'object' && template !== null) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, substitute(value, args)]),
    )
  }
  return template
}

/** Expand every alias call in a query against the project's `finders`, recursively. */
export function resolveAliases(
  node: unknown,
  aliases: Readonly<Record<string, unknown>>,
  seen: readonly string[] = [],
): unknown {
  if (Array.isArray(node)) return node.map((item) => resolveAliases(item, aliases, seen))
  if (typeof node !== 'object' || node === null) return node

  if (isAliasCall(node)) {
    const [name] = Object.keys(node) as [string]
    const template = aliases[name]
    if (template === undefined) {
      const known = Object.keys(aliases).sort()
      throw new Error(
        `unknown finder "${name}"${known.length ? ` — this project defines ${known.join(', ')}` : ''}`,
      )
    }
    if (seen.includes(name)) {
      throw new Error(`finder "${name}" refers to itself (${[...seen, name].join(' → ')})`)
    }
    const raw = node[name]
    const args = (Array.isArray(raw) ? raw : [raw]).map(String)
    return resolveAliases(substitute(template, args), aliases, [...seen, name])
  }

  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, resolveAliases(value, aliases, seen)]),
  )
}

/**
 * A query schema that expands this project's aliases first.
 *
 * Alias expansion has to be scoped to query positions. Run over a whole document it
 * would read any one-key mapping — `marks:`, `style:` — as a call to a finder nobody
 * defined.
 */
export function makeQuery(aliases: Readonly<Record<string, unknown>>): z.ZodType<QueryInput> {
  if (Object.keys(aliases).length === 0) return Query
  return z.preprocess((node) => resolveAliases(node, aliases), Query) as z.ZodType<QueryInput>
}

/** Resolve aliases, then validate — so an author sees errors about their query, not the template. */
export function parseQuery(
  node: unknown,
  aliases: Readonly<Record<string, unknown>> = {},
): QueryInput {
  return Query.parse(resolveAliases(node, aliases)) as QueryInput
}

/**
 * Resolve a query to a rect, inside the page.
 *
 * Serialized into the browser, so it closes over nothing and imports nothing. `seeds`
 * carries elements already resolved by Playwright's locator engine (role, label,
 * placeholder, testid); everything else it sources itself.
 */
export function evaluateQuery(
  spec: QueryInput,
  ctx: {
    rects?: Record<string, Rect>
    viewport: { width: number; height: number }
    seeds?: Element[]
  },
): Rect {
  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }

  const dimension = (value: number | string): number => {
    if (typeof value === 'number') return value
    const amount = parseFloat(value)
    if (value.endsWith('vw')) return (ctx.viewport.width * amount) / 100
    if (value.endsWith('vh')) return (ctx.viewport.height * amount) / 100
    return amount
  }

  const padded = (rect: Rect, pad?: number, grow?: Record<string, number | undefined>): Rect => {
    const p = pad ?? 0
    const top = (grow?.top ?? 0) + p
    const right = (grow?.right ?? 0) + p
    const bottom = (grow?.bottom ?? 0) + p
    const left = (grow?.left ?? 0) + p
    return {
      x: rect.x - left,
      y: rect.y - top,
      width: rect.width + left + right,
      height: rect.height + top + bottom,
    }
  }

  if ('rect' in spec) {
    const [x, y, width, height] = spec.rect
    return padded({ x, y, width, height }, spec.pad, spec.grow)
  }

  if ('span' in spec) {
    const parts = spec.span.map((part) => evaluateQuery(part, ctx))
    const x0 = Math.min(...parts.map((r) => r.x))
    const y0 = Math.min(...parts.map((r) => r.y))
    const x1 = Math.max(...parts.map((r) => r.x + r.width))
    const y1 = Math.max(...parts.map((r) => r.y + r.height))
    return padded({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, spec.pad, spec.grow)
  }

  const query = spec
  const describe = JSON.stringify(query)

  let candidates: Element[]
  if (ctx.seeds && ctx.seeds.length > 0) {
    candidates = [...ctx.seeds]
  } else if (query.heading !== undefined) {
    const wanted = query.heading
    candidates = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(
      (el) => (el.textContent || '').trim() === wanted,
    )
  } else {
    candidates = [...document.querySelectorAll(query.css ?? '*')]
  }

  type FilterSet = {
    contains?: string
    containingAll?: string[]
    matching?: string
    text?: string
    maxChildren?: number
    minChildren?: number
    minWidth?: number | string
    maxWidth?: number | string
    minHeight?: number | string
    maxHeight?: number | string
    narrowerThan?: number | string
    widerThan?: number | string
    visible?: boolean
  }

  const matchesFilters = (el: Element, f: FilterSet): boolean => {
    const content = el.textContent || ''
    if (f.contains !== undefined && !content.includes(f.contains)) return false
    if (f.containingAll !== undefined && !f.containingAll.every((part) => content.includes(part)))
      return false
    if (f.matching !== undefined && !new RegExp(f.matching).test(content)) return false
    if (f.text !== undefined && content.trim() !== f.text) return false
    if (f.maxChildren !== undefined && el.children.length > f.maxChildren) return false
    if (f.minChildren !== undefined && el.children.length < f.minChildren) return false

    const r = rectOf(el)
    if (f.visible === true && (r.width <= 0 || r.height <= 0)) return false
    if (f.minWidth !== undefined && r.width < dimension(f.minWidth)) return false
    if (f.maxWidth !== undefined && r.width > dimension(f.maxWidth)) return false
    if (f.minHeight !== undefined && r.height < dimension(f.minHeight)) return false
    if (f.maxHeight !== undefined && r.height > dimension(f.maxHeight)) return false
    if (f.narrowerThan !== undefined && r.width >= dimension(f.narrowerThan)) return false
    if (f.widerThan !== undefined && r.width <= dimension(f.widerThan)) return false
    return true
  }

  const insideScope = (el: Element): boolean => {
    if (query.within === undefined) return true
    const scope = ctx.rects?.[query.within]
    if (!scope)
      throw new Error(`query names within: "${query.within}", which is not a resolved rect`)
    const r = rectOf(el)
    const slack = 2
    return (
      r.x >= scope.x - slack &&
      r.y >= scope.y - slack &&
      r.x + r.width <= scope.x + scope.width + slack &&
      r.y + r.height <= scope.y + scope.height + slack
    )
  }

  candidates = candidates.filter((el) => insideScope(el) && matchesFilters(el, query))

  if (query.ancestor !== undefined) {
    const spec = query.ancestor
    const climbed: Element[] = []
    for (const start of candidates) {
      let el: Element | null = start
      while (el && !matchesFilters(el, spec)) el = el.parentElement
      if (!el) continue
      if (spec.pick === 'outermost') {
        while (el.parentElement && matchesFilters(el.parentElement, spec)) el = el.parentElement
      }
      climbed.push(el)
    }
    candidates = climbed
  }
  if (query.parent === true) {
    candidates = candidates
      .map((el) => el.parentElement)
      .filter((el): el is HTMLElement => el !== null)
  }
  if (query.child !== undefined) {
    const index = query.child
    candidates = candidates.map((el) => el.children[index]).filter((el): el is Element => !!el)
  }
  if (query.children === true) {
    candidates = candidates.flatMap((el) => [...el.children])
  }

  if (candidates.length === 0) throw new Error(`no element matched ${describe}`)

  const area = (el: Element) => {
    const r = rectOf(el)
    return r.width * r.height
  }
  let chosen: Element | undefined
  if (query.nth !== undefined) chosen = candidates[query.nth]
  else if (query.pick === 'last') chosen = candidates[candidates.length - 1]
  else if (query.pick === 'smallest') chosen = [...candidates].sort((a, b) => area(a) - area(b))[0]
  else if (query.pick === 'largest') chosen = [...candidates].sort((a, b) => area(b) - area(a))[0]
  else chosen = candidates[0]

  if (!chosen) throw new Error(`no element at the requested position for ${describe}`)
  return padded(rectOf(chosen), query.pad, query.grow)
}
