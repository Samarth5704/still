/**
 * @vitest-environment happy-dom
 *
 * The generalising half of "text never sits directly on the shader".
 *
 * `style.test.ts` names the six surfaces Phase 7 fixed, which proves those six
 * do not regress and proves nothing at all about the seventh. This walks the
 * real app instead: it builds every view and opens every dialog, finds every
 * element that actually carries words, and requires each one to reach a scrim
 * before it reaches the page. A surface added later without `var(--glass-bg)`
 * fails here on the day it is written, rather than waiting for Phase 8's
 * contrast gate — or for someone to notice a heading disappearing under a
 * passing crest, which is the failure this rule exists to prevent and the one
 * that never shows up in the screenshot you happen to take.
 *
 * The set of scrim-bearing classes is DERIVED from the stylesheet rather than
 * listed here, so the two halves cannot drift: paint `var(--glass-bg)` in a
 * rule and this test knows about it, without anyone remembering to come back.
 *
 * What it cannot do is resolve the cascade — happy-dom has no `@layer` and no
 * `getComputedStyle` over a real stylesheet, which is why this asks about class
 * names and containment rather than about pixels. Contrast against the actual
 * palette range is Phase 8's script; this is the structural question underneath
 * it, and it is the one that catches new code.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// Resolved from the project root, not from `import.meta.url`: under happy-dom
// the module URL is an http one and `fileURLToPath` rejects it.
const css = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8')

/**
 * Every class that paints the shared scrim, read out of the stylesheet.
 *
 * Only the LAST compound in a selector counts: in `.group[data-tone] .group-title`
 * the rule dresses `.group-title`, and crediting `.group` too would let a bare
 * heading pass because its container happened to be named in some other rule.
 */
function scrimClasses(): Set<string> {
  // `.glass` sets `background: var(--glass-bg)` so it is found here like the
  // rest; it is seeded by name only to make the intent obvious at a glance.
  const found = new Set<string>(['glass'])
  for (const [, prelude, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!(body ?? '').includes('var(--glass-bg)')) continue
    for (const selector of (prelude ?? '').split(',')) {
      const last = selector.trim().split(/\s+|>/).pop() ?? ''
      // Strip pseudo-classes, pseudo-elements and attribute selectors so
      // `.view-title:focus-visible` and `.task[hidden]` credit their class.
      const compound = last.replace(/::?[\w-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '')
      for (const [, name] of compound.matchAll(/\.([\w-]+)/g)) found.add(name!)
    }
  }
  return found
}

const SCRIMS = scrimClasses()

/**
 * Text inside a form control paints on the control, not on the page, so a
 * `<select>`'s options and a text input's value are never exposed to the
 * surface however the page behind them is styled.
 */
const CONTROL = new Set(['SELECT', 'OPTION', 'OPTGROUP', 'TEXTAREA', 'INPUT'])

/** Elements holding a direct, non-whitespace text node of their own. */
function textBearing(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (CONTROL.has(el.tagName)) continue
    if (el.classList.contains('sr-only')) continue
    if (el.closest('.sr-only') !== null) continue
    const hasOwnText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '',
    )
    if (hasOwnText) out.push(el)
  }
  return out
}

/** The nearest ancestor-or-self carrying a scrim, or null. */
function scrimFor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el
  while (node !== null && node !== document.body) {
    for (const name of node.classList) if (SCRIMS.has(name)) return node
    node = node.parentElement
  }
  return null
}

function describeNode(el: HTMLElement): string {
  const classes = el.className ? `.${[...el.classList].join('.')}` : ''
  const text = (el.textContent ?? '').trim().slice(0, 40)
  return `<${el.tagName.toLowerCase()}${classes}> ${JSON.stringify(text)}`
}

/** Every scrim failure under `root`, as readable lines. */
function bareText(root: ParentNode): string[] {
  return textBearing(root)
    .filter((el) => scrimFor(el) === null)
    .map(describeNode)
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  localStorage.clear()
  document.body.replaceChildren()
  const app = document.createElement('div')
  app.id = 'app'
  document.body.append(app)
  location.hash = '#/today'

  // The real app, wired exactly as it ships. Importing it is the point: a view
  // this file forgot to build is a view this test cannot vouch for, and the
  // module graph is the only thing that knows what the app is made of.
  await import('../main.ts')
})

/** Add tasks the way a user does, through the app's own quick-add. */
function quickAdd(...lines: string[]): void {
  const input = document.querySelector<HTMLInputElement>('#quick-add')
  expect(input?.form, 'quick add did not render').toBeTruthy()
  for (const line of lines) {
    input!.value = line
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
}

function show(hash: string): void {
  location.hash = hash
  globalThis.dispatchEvent(new Event('hashchange'))
}

describe('the scrim set is real', () => {
  it('was actually read out of the stylesheet', () => {
    // A parser that quietly matched nothing would make every test below pass.
    expect(SCRIMS.size).toBeGreaterThan(4)
    for (const known of ['glass', 'task', 'empty', 'view-title', 'group-title', 'cal-head']) {
      expect([...SCRIMS], `${known} should be a scrim`).toContain(known)
    }
  })

  it('does not credit a container for the scrim of its child', () => {
    // `.group` holds the heading; it paints nothing itself. If this ever starts
    // failing, the last-compound rule above has been loosened and a bare
    // heading inside any named container would slip through.
    expect([...SCRIMS]).not.toContain('group')
  })
})

/*
 * Declared before the suite that seeds the store, so it runs against the app as
 * it actually boots for a new user. An empty list is the calmest the surface
 * ever gets and therefore the most visible it ever gets, which makes the empty
 * state the last place bare text is survivable and the first place it looks
 * deliberate.
 */
describe('the empty state', () => {
  it('is on a scrim before anything has been added', () => {
    show('#/today')
    const empty = document.querySelector<HTMLElement>('.empty')
    expect(empty, 'a fresh app should render an empty state').not.toBeNull()
    expect(textBearing(empty!).length).toBeGreaterThan(2)
    expect(bareText(document.querySelector('#app')!)).toEqual([])
  })
})

describe('every view', () => {
  beforeAll(() => {
    show('#/today')
    quickAdd(
      'Submit finance assignment tomorrow !! #uni',
      'Renew passport 23 dec @admin',
      'Standup every weekday at 9am',
      'No date at all',
    )
  })

  it.each(['#/today', '#/upcoming', '#/all', '#/calendar'])(
    '%s puts no text on the surface',
    (hash) => {
      show(hash)
      const app = document.querySelector('#app')
      expect(app).not.toBeNull()
      // Sanity: a view that rendered nothing would pass vacuously.
      expect(textBearing(app!).length).toBeGreaterThan(3)
      expect(bareText(app!)).toEqual([])
    },
  )
})

describe('every dialog', () => {
  it.each(['.detail', '.manage', '.settings', '.repeat-editor'])('%s sits on glass', (selector) => {
    const dialog = document.querySelector<HTMLElement>(selector)
    expect(dialog, `${selector} was not built at boot`).not.toBeNull()
    expect(scrimFor(dialog!), `${selector} is not on a scrim`).not.toBeNull()
    expect(bareText(dialog!)).toEqual([])
  })
})

describe('the floating surfaces', () => {
  it('the undo bar carries its own scrim', () => {
    const bar = document.querySelector<HTMLElement>('.undo-bar')
    expect(bar).not.toBeNull()
    expect(scrimFor(bar!)).not.toBeNull()
  })

  it('the read-only banner does too', () => {
    // Built only when the stored data came from a newer build, so it is never
    // in the tree the views above walk — and it is the one line a user in that
    // state has to be able to read.
    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.textContent = 'This data was saved by a newer version of Still.'
    document.body.append(banner)
    expect(scrimFor(banner)).not.toBeNull()
    banner.remove()
  })

  it('the skip link does too', () => {
    // It lives in index.html rather than in a module, so there is no node here
    // to walk; the stylesheet is the whole of the claim.
    expect(SCRIMS.has('skip-link'), 'the skip link must sit on a scrim').toBe(true)
  })
})
