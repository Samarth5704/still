/**
 * @vitest-environment happy-dom
 *
 * The surface controller, without a GPU.
 *
 * happy-dom has no WebGL2, which is not a limitation here — it is the exact
 * condition the fallback exists for, and the branch most likely to rot,
 * because nobody developing this ever sees it. Everything asserted below is
 * either the pure preference table or the DOM the controller owns; the
 * shader's own behaviour is Phase 2's suite and the lab page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSurface, REDUCED_MOTION, RIPPLE_EVENT, resolveEffects, resolveMode } from './surface.ts'
import type { PressureSummary } from '../lib/types.ts'

function summary(pressure: number, heat: number): PressureSummary {
  return { pressure, heat, load: pressure * 100, openCount: 3, overdueCount: heat > 0 ? 1 : 0 }
}

const mounted: AppSurface[] = []

function mount(): AppSurface {
  const s = new AppSurface(document.body)
  mounted.push(s)
  return s
}

/**
 * A controllable `prefers-reduced-motion`.
 *
 * happy-dom's own `matchMedia` never changes, and "never changes" is precisely
 * the behaviour this phase was asked to stop shipping — so the query is stubbed
 * with one that can be flipped and that fires `change` like the real thing.
 */
let motionListeners: (() => void)[] = []
let motionMatches = false

function setReducedMotion(matches: boolean): void {
  motionMatches = matches
  for (const fire of [...motionListeners]) fire()
}

beforeEach(() => {
  motionListeners = []
  motionMatches = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return query === REDUCED_MOTION && motionMatches
    },
    addEventListener: (_: string, fn: () => void) => void motionListeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      motionListeners = motionListeners.filter((l) => l !== fn)
    },
  }))
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.dispose()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('--glass-tint')
  document.body.replaceChildren()
})

describe('resolveEffects', () => {
  it('is the only value that asks the OS', () => {
    expect(resolveEffects('auto', true)).toBe('reduced')
    expect(resolveEffects('auto', false)).toBe('full')
  })

  /*
   * The reason `auto` had to exist. With three values an explicit `full` is
   * indistinguishable from the default `full`, so following the OS overrules
   * someone who asked for motion and ignoring it overrules someone who asked
   * for none. A choice wins in BOTH directions or the preference is not
   * independent of the OS setting, it is just unaware of it.
   */
  it.each(['full', 'reduced', 'off'] as const)('leaves an explicit %s alone', (setting) => {
    expect(resolveEffects(setting, true)).toBe(setting)
    expect(resolveEffects(setting, false)).toBe(setting)
  })
})

describe('resolveMode', () => {
  it.each([
    ['auto', false, true, 'shader'],
    ['auto', true, true, 'still'],
    ['full', false, true, 'shader'],
    ['full', true, true, 'shader'],
    ['reduced', false, true, 'still'],
    ['off', true, true, 'fallback'],
    ['auto', false, false, 'fallback'],
    ['full', false, false, 'fallback'],
    ['reduced', false, false, 'fallback'],
  ] as const)('%s with reduce=%s webgl2=%s is %s', (setting, motion, webgl2, expected) => {
    expect(resolveMode(setting, motion, webgl2)).toBe(expected)
  })

  /*
   * `reduced` is not `off` and it is not `fallback`. uStill damps flow, warp
   * and ripples to nothing — frequency, relief, seat level and palette keep
   * following pressure and heat — so a user who asked for less motion still
   * gets a surface that reports. Collapsing this to the gradient was the
   * tempting simplification and it silently removes information from the users
   * most likely to need it.
   */
  it('does not send a reduced-motion user to the fallback', () => {
    expect(resolveMode('reduced', true, true)).not.toBe('fallback')
    expect(resolveMode('auto', true, true)).not.toBe('fallback')
  })

  it('lets WebGL2 overrule every preference, but nothing else', () => {
    for (const setting of ['auto', 'full', 'reduced', 'off'] as const) {
      expect(resolveMode(setting, false, false)).toBe('fallback')
    }
  })
})

describe('AppSurface', () => {
  it('mounts behind the app and takes no pointer targets of its own', () => {
    const app = document.createElement('div')
    app.id = 'app'
    document.body.append(app)

    const surface = mount()
    expect(document.body.firstElementChild).toBe(surface.root)
    expect(surface.root.getAttribute('aria-hidden')).toBe('true')
    expect(surface.root.querySelector('canvas')).not.toBeNull()
  })

  it('shows the fallback and hides the canvas when there is no WebGL2', () => {
    const surface = mount()
    expect(surface.hasShader).toBe(false)

    surface.apply(summary(0.4, 0.2), 'full')

    expect(surface.currentMode).toBe('fallback')
    expect(surface.root.dataset.mode).toBe('fallback')
    expect(surface.root.querySelector<HTMLElement>('.still-fallback')!.hidden).toBe(false)
    expect(surface.root.querySelector<HTMLCanvasElement>('canvas')!.hidden).toBe(true)
  })

  it('drives the fallback from the same two numbers as the shader', () => {
    const surface = mount()
    const el = surface.root.querySelector<HTMLElement>('.still-fallback')!

    surface.apply(summary(0.75, 0), 'full')
    expect(el.style.getPropertyValue('--sf-spread')).toBe('0.75')
    const cool = el.style.getPropertyValue('--sf-light')

    surface.apply(summary(0.75, 1), 'full')
    // Same pressure, all of it late: the spread holds and the ramp moves.
    expect(el.style.getPropertyValue('--sf-spread')).toBe('0.75')
    expect(el.style.getPropertyValue('--sf-light')).not.toBe(cool)
  })

  it('tints the glass shadow from heat, in fallback mode too', () => {
    const surface = mount()

    surface.apply(summary(0.3, 0), 'full')
    const cool = document.documentElement.style.getPropertyValue('--glass-tint')

    surface.apply(summary(0.3, 1), 'full')
    const warm = document.documentElement.style.getPropertyValue('--glass-tint')

    expect(cool).toMatch(/^rgb\(/)
    expect(warm).not.toBe(cool)
  })

  it('survives a completion when there is nothing to ripple', () => {
    const surface = mount()
    surface.apply(summary(0.2, 0), 'full')

    expect(() => {
      globalThis.dispatchEvent(
        new CustomEvent(RIPPLE_EVENT, { detail: { x: 120, y: 300, strength: 1 } }),
      )
    }).not.toThrow()
  })

  it('listens for ripples fired by anything, not just the list', () => {
    // main.ts, the detail dialog's subtasks and the calendar all dispatch the
    // same event; the controller must not need to know which.
    const surface = mount()
    const spy = vi.spyOn(surface, 'ripple')
    surface.apply(summary(0.2, 0), 'full')

    globalThis.dispatchEvent(new CustomEvent(RIPPLE_EVENT, { detail: { x: 1, y: 2 } }))

    expect(spy).toHaveBeenCalledWith(1, 2, 1)
  })

  it('stops listening once disposed', () => {
    const surface = mount()
    const spy = vi.spyOn(surface, 'ripple')
    surface.dispose()
    mounted.length = 0

    globalThis.dispatchEvent(new CustomEvent(RIPPLE_EVENT, { detail: { x: 1, y: 2 } }))

    expect(spy).not.toHaveBeenCalled()
    expect(surface.root.isConnected).toBe(false)
  })

  it('follows prefers-reduced-motion while the app is open, not just at boot', () => {
    // A preference that only lands on the next reload is one the user has to
    // discover is a reload away. There is no shader here, so the visible proof
    // is the resolved mode rather than the canvas.
    const surface = mount()
    surface.apply(summary(0.4, 0.1), 'auto')
    expect(surface.prefersReducedMotion).toBe(false)

    setReducedMotion(true)
    expect(surface.prefersReducedMotion).toBe(true)

    setReducedMotion(false)
    expect(surface.prefersReducedMotion).toBe(false)
  })

  it('re-resolves on a motion change without restarting the ease', () => {
    // The backlog is exactly where it was, so the targets must not be touched:
    // re-running apply() here would re-snap or re-ease the surface every time
    // someone toggled an OS setting.
    const surface = mount()
    surface.apply(summary(0.4, 0.1), 'auto')
    const spy = vi.spyOn(surface, 'apply')

    setReducedMotion(true)

    expect(spy).not.toHaveBeenCalled()
  })

  it('a motion change can never enter or leave the fallback', () => {
    // Only WebGL2 and an explicit `off` choose the fallback, and neither reads
    // the media query — which is what lets the change handler skip repainting
    // the gradient.
    for (const setting of ['auto', 'full', 'reduced', 'off'] as const) {
      expect(resolveMode(setting, true, true) === 'fallback').toBe(
        resolveMode(setting, false, true) === 'fallback',
      )
    }
  })

  it('stops following the media query once disposed', () => {
    const surface = mount()
    surface.apply(summary(0.4, 0.1), 'auto')
    surface.dispose()
    mounted.length = 0

    expect(() => setReducedMotion(true)).not.toThrow()
    expect(motionListeners).toHaveLength(0)
  })

  /*
   * A custom property on `:root` invalidates every rule that reads it, so each
   * write is a document-wide style recalc. This was never per-frame — apply()
   * runs per store change and reads the *target* heat, while the two-second
   * ease happens inside the renderer — but a burst of edits still produced one
   * invalidation each, measured at 60 writes in 44ms across 30 quick-adds, all
   * of them the same colour.
   */
  it('writes the tint only when the resolved colour changes', () => {
    const surface = mount()
    const spy = vi.spyOn(document.documentElement.style, 'setProperty')

    surface.apply(summary(0.2, 0.4), 'full')
    const first = spy.mock.calls.filter(([k]) => k === '--glass-tint').length
    expect(first).toBe(1)

    // Twenty renders that move pressure but not heat: the shadow is a function
    // of heat alone, so none of them is a new colour.
    for (let i = 0; i < 20; i += 1) surface.apply(summary(i / 20, 0.4), 'full')
    expect(spy.mock.calls.filter(([k]) => k === '--glass-tint')).toHaveLength(1)

    surface.apply(summary(0.2, 0.9), 'full')
    expect(spy.mock.calls.filter(([k]) => k === '--glass-tint')).toHaveLength(2)
  })

  it('still writes a heat change too small to see as nothing at all', () => {
    // The dedupe is string equality on the resolved 8-bit colour, so the test
    // for "perceptible" is the paint itself rather than an epsilon somebody
    // has to keep honest.
    const surface = mount()
    surface.apply(summary(0.2, 0.4), 'full')
    const spy = vi.spyOn(document.documentElement.style, 'setProperty')

    surface.apply(summary(0.2, 0.4001), 'full')

    expect(spy.mock.calls.filter(([k]) => k === '--glass-tint')).toHaveLength(0)
  })

  it('repaints the fallback on every change, so it never shows a stale load', () => {
    const surface = mount()
    const el = surface.root.querySelector<HTMLElement>('.still-fallback')!

    surface.apply(summary(0.1, 0), 'off')
    surface.apply(summary(0.9, 0), 'off')

    expect(el.style.getPropertyValue('--sf-spread')).toBe('0.9')
  })
})
