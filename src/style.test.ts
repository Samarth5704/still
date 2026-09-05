/**
 * Stylesheet structure guards.
 *
 * These are not rendering tests — Vitest runs in a node environment with no
 * browser, and jsdom implements neither cascade layers nor `getComputedStyle`
 * over a real stylesheet, so it could not tell you what these rules actually
 * do. What they assert is the *source structure* that two real defects came
 * from, both of which failed silently and neither of which any unit test could
 * have caught:
 *
 *   - Nav overrides written in `@layer layout` while the base `.app-nav` rules
 *     live in `@layer components`. A later layer beats an earlier one no matter
 *     how specific the selector, so `position: sticky` quietly won and the
 *     mobile bottom bar never appeared.
 *   - `.undo-bar { display: flex }` beating the user-agent `[hidden]` rule, so
 *     a dismissed undo bar kept its place in the layout and stayed focusable.
 *
 * Both are one careless edit away from returning. The behavioural versions of
 * these checks belong in Phase 8, which adds CI and a script that samples the
 * rendered page; until that exists, these hold the line.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Read from disk rather than `import css from './style.css?raw'`: Vitest stubs
// CSS imports to an empty string in a node environment, so the raw query
// silently yields '' and every assertion below would pass vacuously.
const css = readFileSync(fileURLToPath(new URL('./style.css', import.meta.url)), 'utf8')

/** The body of a top-level `@layer <name> { ... }` block, by brace matching. */
function layerBody(name: string): string {
  const start = css.indexOf(`@layer ${name} {`)
  expect(start, `no @layer ${name} block`).toBeGreaterThan(-1)

  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(css.indexOf('{', start) + 1, i)
    }
  }
  throw new Error(`unterminated @layer ${name}`)
}

describe('cascade layers', () => {
  it('declares the layer order up front', () => {
    // Declaring the order in one statement is what makes the rest of this file
    // meaningful: without it, order depends on where each block happens to sit.
    expect(css).toMatch(/@layer\s+reset\s*,\s*tokens\s*,\s*base\s*,\s*layout\s*,\s*components\s*,\s*utilities\s*;/)
  })

  it('keeps component overrides out of the layout layer', () => {
    // `.app-nav`, `.nav-link` and friends are styled in the components layer.
    // A rule for them here would be overridden by that later layer and would
    // appear to do nothing at all.
    const layout = layerBody('layout')
    for (const selector of ['.app-nav', '.nav-link', '.nav-list', '.nav-count']) {
      expect(layout, `${selector} is styled in @layer layout; it belongs in components`).not.toContain(
        selector,
      )
    }
  })

  it('styles the nav in the components layer, mobile rules included', () => {
    const components = layerBody('components')
    expect(components).toContain('.app-nav')
    // The bottom-bar override has to sit alongside the desktop rules.
    expect(components).toMatch(/@media\s*\(width\s*<\s*720px\)[\s\S]*?\.app-nav\s*\{[\s\S]*?position:\s*fixed/)
  })
})

describe('hidden elements stay hidden', () => {
  /*
   * Any element given a `display` value in this stylesheet outranks the
   * user-agent `[hidden] { display: none }` rule, so anything toggled with the
   * `hidden` property needs its own opt-out. These are the elements the app
   * hides that way.
   */
  const hiddenByScript = ['.undo-bar', '.move']

  it.each(hiddenByScript)('%s has a [hidden] rule that beats its own display', (selector) => {
    const pattern = new RegExp(
      `\\${selector}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`,
      's',
    )
    expect(css, `${selector} sets display but has no [hidden] { display: none }`).toMatch(pattern)
  })

  it('gives every element that sets display and is script-hidden an escape hatch', () => {
    // A tripwire for the next one: if a selector below starts setting `display`
    // and the app hides it with `hidden`, it must join the list above.
    for (const selector of hiddenByScript) {
      const sets = new RegExp(`\\${selector}\\s*\\{[^}]*display:`, 's')
      expect(css, `${selector} no longer sets display; the [hidden] guard may be stale`).toMatch(sets)
    }
  })
})
