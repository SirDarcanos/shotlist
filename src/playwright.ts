import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ShotlistError } from './config.js'

/** The slice of Playwright this package uses, so the optional peer needs no type import. */
export interface PlaywrightModule {
  chromium: {
    launch(options?: { channel?: string; headless?: boolean }): Promise<Browser>
  }
}

export interface Browser {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>
  close(): Promise<void>
}

export interface BrowserContext {
  newPage(): Promise<Page>
  close(): Promise<void>
}

export interface Page {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  setContent(html: string, options?: Record<string, unknown>): Promise<void>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  screenshot(options?: Record<string, unknown>): Promise<Buffer>
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
  evaluateHandle<R, A>(fn: (arg: A) => R, arg: A): Promise<JSHandle<R>>
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> }
  getByRole(role: string, options?: Record<string, unknown>): Locator
  getByLabel(text: string, options?: Record<string, unknown>): Locator
  getByPlaceholder(text: string, options?: Record<string, unknown>): Locator
  getByTestId(id: string): Locator
  close(): Promise<void>
  url(): string
}

export interface Locator {
  elementHandles(): Promise<ElementHandle[]>
}

export interface JSHandle<T = unknown> {
  evaluate<R>(fn: (handle: T) => R): Promise<R>
  getProperty(name: string): Promise<JSHandle>
  asElement(): ElementHandle | null
  dispose(): Promise<void>
}

export interface ElementHandle extends JSHandle<Element> {
  click(options?: Record<string, unknown>): Promise<void>
  dblclick(options?: Record<string, unknown>): Promise<void>
  hover(options?: Record<string, unknown>): Promise<void>
  fill(value: string, options?: Record<string, unknown>): Promise<void>
  selectOption(values: unknown, options?: Record<string, unknown>): Promise<string[]>
  check(options?: Record<string, unknown>): Promise<void>
  uncheck(options?: Record<string, unknown>): Promise<void>
  press(key: string, options?: Record<string, unknown>): Promise<void>
  type(text: string, options?: Record<string, unknown>): Promise<void>
  focus(): Promise<void>
  scrollIntoViewIfNeeded(options?: Record<string, unknown>): Promise<void>
  inputValue(options?: Record<string, unknown>): Promise<string>
}

/**
 * Find Playwright without depending on it.
 *
 * Its postinstall downloads browsers, so a project consuming shotlist must not pay for
 * it on every install. It is resolved from the project, then from the npx cache, and
 * failing both the error is the command that fixes it.
 */
export function loadPlaywright(): PlaywrightModule {
  const require = createRequire(import.meta.url)
  const candidates = ['playwright', 'playwright-core']
  const npx = join(homedir(), '.npm', '_npx')
  try {
    for (const dir of readdirSync(npx)) {
      candidates.push(join(npx, dir, 'node_modules', 'playwright'))
    }
  } catch {
    // No npx cache; the plain specifiers above may still resolve.
  }
  for (const candidate of candidates) {
    try {
      return require(candidate) as PlaywrightModule
    } catch {
      continue
    }
  }
  throw new ShotlistError(
    'Playwright is not installed. shotlist does not install it, because its postinstall ' +
      'downloads browsers. Install it with:\n  npm i -D playwright',
  )
}
