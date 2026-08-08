import { z } from 'zod'

/** A rectangle in CSS pixels, relative to the viewport. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const Dimension = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(px|vw|vh)$/)])

/** A whole number, or a `$name` standing in for one until the step runs. */
export const NumberOrRef = z.union([z.int(), z.string().regex(/^\$\{?[A-Za-z_]/)])

/**
 * A position in a list of candidates.
 *
 * Negative counts from the end, the way `Array.at` does, so `-2` is the second from last
 * — which nothing else in the language can say. `-1` is the last, which `pick: last` also
 * says; a run that meets one says so rather than refusing it.
 */
const Index = NumberOrRef

const Filters = z.object({
  contains: z.string().optional(),
  containingAll: z.array(z.string()).optional(),
  matching: z.string().optional(),
  text: z.string().optional(),
  startsWith: z.string().optional(),
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

/** Room added on a side. Not taken away: `pad: -8` is not padding, it is a smaller query. */
const Room = z
  .number()
  .nonnegative({ message: 'is room added around a box, so it cannot be negative' })

const Grow = z
  .object({
    top: Room.optional(),
    right: Room.optional(),
    bottom: Room.optional(),
    left: Room.optional(),
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

  // Scope: an already-resolved rect by name (a mark, or `clip`), or a query resolved on
  // the spot. Candidates must sit geometrically inside it. A query used here resolves in
  // the page, so it cannot use the sources Playwright's engine answers.
  within: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),

  // Traversal, applied in this order.
  ancestor: Ancestor.optional(),
  parent: z.boolean().optional(),
  child: Index.optional(),
  children: z.boolean().optional(),

  pick: z.enum(['first', 'last', 'smallest', 'largest']).optional(),
  nth: Index.optional(),

  pad: Room.optional(),
  grow: Grow.optional(),
}).strict()

/** The bounding box of several queries at once — console.py's `span()`. */
export const SpanQuery = z
  .object({
    span: z.array(z.lazy(() => Query)),
    pad: Room.optional(),
    grow: Grow.optional(),
  })
  .strict()

/** A literal box in image pixels, for a recipe annotating a PNG with no DOM to query. */
export const RectQuery = z
  .object({
    // x and y may be anywhere, including off the top-left; a width or a height that is
    // not there is not a box.
    rect: z.tuple([z.number(), z.number(), z.number().nonnegative(), z.number().nonnegative()]),
    pad: Room.optional(),
    grow: Grow.optional(),
  })
  .strict()

const SOURCES = ['css', 'role', 'label', 'placeholder', 'testid', 'heading'] as const

/** A query names at most one source; filters then narrow whatever it found. */
const OneSource = ElementQuery.refine(
  (q) => SOURCES.filter((key) => (q as Record<string, unknown>)[key] !== undefined).length <= 1,
  {
    message: `a query names at most one of ${SOURCES.join(', ')} — filters narrow what it finds`,
  },
)

export const Query: z.ZodType<QueryInput> = z.union([RectQuery, SpanQuery, OneSource])

// `within` is stated by hand, as an interface. It refers back to Query, and a type alias
// cannot reference itself through z.input — an interface can.
type ElementQueryBase = Omit<z.input<typeof ElementQuery>, 'within'>

export interface ElementQueryInput extends ElementQueryBase {
  /** A resolved rect by name, or a query resolved on the spot. */
  within?: string | QueryInput
}
export type QueryInput =
  | ElementQueryInput
  | { rect: [number, number, number, number]; pad?: number; grow?: z.infer<typeof Grow> }
  | { span: QueryInput[]; pad?: number; grow?: z.infer<typeof Grow> }

/** Every key `ElementQuery` understands — anything else in a one-key object is an alias call. */
export const QUERY_KEYS: ReadonlySet<string> = new Set(Object.keys(ElementQuery.shape))

/** The key naming the finder in an alias call, or null if the node is a plain query. */
export function aliasKeyOf(node: unknown): string | null {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return null
  const foreign = Object.keys(node as object).filter(
    (key) => !QUERY_KEYS.has(key) && key !== 'span' && key !== 'rect',
  )
  return foreign.length === 1 ? foreign[0]! : null
}

/** Keys whose value is never a query, so nothing inside them is a call to a finder. */
const NOT_A_QUERY: ReadonlySet<string> = new Set(['grow', 'rect'])

/** Whether a node calls a finder — `{ trackerRow: "Zara" }` — rather than being a query. */
export function isAliasCall(node: unknown): node is Record<string, unknown> {
  return aliasKeyOf(node) !== null
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

  const name = aliasKeyOf(node)
  if (name !== null) {
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
    const call = node as Record<string, unknown>
    const raw = call[name]
    const args = raw === null || raw === true ? [] : (Array.isArray(raw) ? raw : [raw]).map(String)
    // Keys written alongside the call are the caller's own — `{ listRow: "Acme", pad: 16 }`
    // pads what the finder found, rather than being refused for not being a finder.
    const extra = Object.fromEntries(Object.entries(call).filter(([key]) => key !== name))
    const expanded = substitute(template, args) as Record<string, unknown>
    return resolveAliases({ ...expanded, ...extra }, aliases, [...seen, name])
  }

  return Object.fromEntries(
    Object.entries(node).map(([key, value]) =>
      // `grow` holds sides, not a query. Its keys are not query keys, so a single-sided
      // one — `grow: { left: 4 }` — read as a call to a finder named `left`, and the
      // documented form has never worked with fewer than two sides.
      NOT_A_QUERY.has(key) ? [key, value] : [key, resolveAliases(value, aliases, seen)],
    ),
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

/** The rect a query resolves to, for callers that do not need the element. */
export function evaluateQuery(context: QueryContext): Rect {
  return resolveQuery(context).rect
}

/** Resolve aliases, then validate — so an author sees errors about their query, not the template. */
export function parseQuery(
  node: unknown,
  aliases: Readonly<Record<string, unknown>> = {},
): QueryInput {
  refuseDeepNesting(node)
  return Query.parse(resolveAliases(node, aliases)) as QueryInput
}

/** How far a query may nest. Far past anything a person writes, and short of the stack. */
export const MAX_QUERY_DEPTH = 64

/**
 * Refuse a query nested deeper than anyone means it.
 *
 * `span` holds queries, so a query can nest without limit — and everything that walks one
 * recurses, including the schema. Deep enough and the whole thing dies of a stack
 * overflow, which is a crash rather than a complaint. Counted iteratively, so the check
 * cannot go the same way as what it is checking.
 */
export function refuseDeepNesting(node: unknown, limit = MAX_QUERY_DEPTH): void {
  const pending: [unknown, number][] = [[node, 1]]
  for (;;) {
    const next = pending.pop()
    if (!next) return
    const [value, depth] = next
    if (typeof value !== 'object' || value === null) continue
    if (depth > limit) {
      throw new Error(`a query nested more than ${limit} deep, which is deeper than it can mean`)
    }
    for (const inner of Object.values(value)) pending.push([inner, depth + 1])
  }
}

/** Everything the page needs to answer one query. */
export interface QueryContext {
  spec: QueryInput
  viewport: { width: number; height: number }
  /** Rects already resolved in this recipe, for `within`. */
  rects?: Record<string, Rect>
  /** Elements Playwright's locator engine found for `role`/`label`/`placeholder`/`testid`. */
  seeds?: Element[]
  /**
   * Report every element the query matched, not only the one it settles on.
   *
   * `mask` and `check.ignore` cover regions rather than pointing at one thing, and a
   * page has three avatars far more often than it has one. A query that names `pick` or
   * `nth` has already said it means a single element, and still gets that.
   */
  all?: boolean
}

/** A query's answer: the box to draw on, and the element to act on if there is one. */
export interface Resolved {
  rect: Rect
  element: Element | null
  /** Every match, when `all` was asked for. `rect` is still the one it settled on. */
  rects?: Rect[]
}

/**
 * Resolve a query, inside the page.
 *
 * Serialized into the browser, so it closes over nothing and imports nothing — which is
 * also what lets the same function be unit-tested in jsdom. It returns the element as
 * well as the rect so that drawing a box and clicking a button never disagree about
 * which element a query meant.
 */
export function resolveQuery(context: QueryContext): Resolved {
  const spec = context.spec
  const ctx = context
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
    const box = {
      x: rect.x - left,
      y: rect.y - top,
      width: rect.width + left + right,
      height: rect.height + top + bottom,
    }
    // A box with no area is not one, and the screenshot's complaint about the clip it
    // becomes says nothing about the query that produced it. `visible: true` is the
    // filter for skipping these rather than resolving to one.
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(
        `${describe} resolved to a box of ${box.width}×${box.height}, which has no area`,
      )
    }
    return box
  }

  if ('rect' in spec) {
    const [x, y, width, height] = spec.rect
    return { rect: padded({ x, y, width, height }, spec.pad, spec.grow), element: null }
  }

  if ('span' in spec) {
    const parts: Rect[] = spec.span.map(
      (part: QueryInput) => resolveQuery({ ...ctx, spec: part }).rect,
    )
    const x0 = Math.min(...parts.map((r) => r.x))
    const y0 = Math.min(...parts.map((r) => r.y))
    const x1 = Math.max(...parts.map((r) => r.x + r.width))
    const y1 = Math.max(...parts.map((r) => r.y + r.height))
    return {
      rect: padded({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, spec.pad, spec.grow),
      element: null,
    }
  }

  const query = spec
  const describe = JSON.stringify(query)

  // `role`, `label`, `placeholder` and `testid` are answered by Playwright's own engine
  // before this runs, and it only seeds the query it was handed. Nested in a `span` or a
  // `within`, one of them would silently fall through to every element on the page and
  // pick whichever came first — a wrong box drawn without complaint.
  // Seeds absent entirely means nobody ran that engine — the query is nested. Seeds
  // present but empty means it ran and found nothing, which is an ordinary no-match and
  // has to say so: sending someone to look for a nesting problem they do not have is
  // worse than saying nothing.
  const seeded = ['role', 'label', 'placeholder', 'testid'] as const
  const needsSeeds = seeded.filter((key) => query[key] !== undefined)
  if (needsSeeds.length > 0 && ctx.seeds === undefined) {
    throw new Error(
      `\`${needsSeeds[0]}\` cannot be used inside \`span\` or \`within\` — it is resolved ` +
        `before the page is searched. Use css, text, startsWith or contains there instead.`,
    )
  }

  let candidates: Element[]
  if (ctx.seeds !== undefined) {
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
    startsWith?: string
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
    if (f.startsWith !== undefined && !content.trim().startsWith(f.startsWith)) return false
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

  // Resolved once, not per candidate: a `within` that is itself a query would otherwise
  // be re-run against every element on the page.
  const scope =
    query.within === undefined
      ? undefined
      : typeof query.within === 'string'
        ? ctx.rects?.[query.within]
        : resolveQuery({ ...ctx, spec: query.within as QueryInput }).rect
  if (query.within !== undefined && !scope) {
    throw new Error(`query names within: "${String(query.within)}", which is not a resolved rect`)
  }

  const insideScope = (el: Element): boolean => {
    if (!scope) return true
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
      // From the parent up. An element is not its own ancestor, and starting at it
      // silently returned the element itself whenever the filters happened to fit —
      // a heading is as wide as its column, so climbing out of one by width found the
      // heading and drew a box round that instead.
      let el: Element | null = start.parentElement
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
    const index = Number(query.child)
    candidates = candidates
      .map((el) => el.children[index < 0 ? el.children.length + index : index])
      .filter((el): el is Element => !!el)
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
  if (query.nth !== undefined) {
    const index = Number(query.nth)
    chosen = candidates[index < 0 ? candidates.length + index : index]
  } else if (query.pick === 'last') chosen = candidates[candidates.length - 1]
  else if (query.pick === 'smallest') chosen = [...candidates].sort((a, b) => area(a) - area(b))[0]
  else if (query.pick === 'largest') chosen = [...candidates].sort((a, b) => area(b) - area(a))[0]
  else chosen = candidates[0]

  if (!chosen) throw new Error(`no element at the requested position for ${describe}`)
  const rect = padded(rectOf(chosen), query.pad, query.grow)
  const singled = query.nth !== undefined || query.pick !== undefined
  if (!ctx.all || singled) return { rect, element: chosen }
  return {
    rect,
    element: chosen,
    rects: candidates.map((el) => padded(rectOf(el), query.pad, query.grow)),
  }
}
