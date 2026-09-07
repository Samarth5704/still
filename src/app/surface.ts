/**
 * The live surface, behind the app.
 *
 * Phase 2 built the shader against sliders; this is the module that replaces
 * the sliders with the backlog. It owns three things and nothing else: the two
 * nodes the surface is drawn on, the translation from a `PressureSummary` into
 * the renderer's two channels, and the ripple listener.
 *
 * It deliberately does not know what a task is. `lib/pressure.ts` has already
 * turned the list into two numbers in 0..1 and the store hands them over on
 * every change, so the surface cannot develop its own opinion about what
 * "busy" means — there is one definition and the header's word, the live
 * summary and the shader all read it.
 *
 * Nothing here runs per frame. The renderer's loop is the only thing that does,
 * and it touches no DOM; everything in this file happens on a store change, of
 * which there are a handful per minute at worst.
 */
import { DEFAULT_PALETTE, type Palette } from '../gl/palette.ts'
import { Surface } from '../gl/renderer.ts'
import type { SurfaceStats } from '../gl/renderer.ts'
import { paintFallback } from '../gl/fallback.ts'
import { shadowTintCSS } from '../gl/tint.ts'
import type { EffectsSetting, PressureSummary } from '../lib/types.ts'

/** The event any completion fires, from the checkbox that was ticked. */
export const RIPPLE_EVENT = 'still:ripple'

export type RippleDetail = { x: number; y: number; strength?: number }

/**
 * What the surface is actually doing, once the stored preference has met
 * reality.
 *
 * `still` is not `fallback` with extra steps and it is not the shader turned
 * off: `uStill` damps flow and warp only, so frequency, relief, seat level and
 * palette all still follow pressure and heat. A user who has asked for less
 * motion keeps every bit of the information and loses only the movement. That
 * was settled at the shader in Phase 2 and this is the code that has to honour
 * it.
 */
export type SurfaceMode = 'shader' | 'still' | 'fallback'

/** The media query the `auto` setting follows. */
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/**
 * What `auto` means right now.
 *
 * Only `auto` asks the OS. An explicit `full`, `reduced` or `off` is a choice
 * the user made in this app and it outranks the system preference in both
 * directions — which is the whole point of the fourth value, and the reason
 * the migration in `lib/storage.ts` had to exist.
 */
export function resolveEffects(
  setting: EffectsSetting,
  reducedMotion: boolean,
): Exclude<EffectsSetting, 'auto'> {
  if (setting !== 'auto') return setting
  return reducedMotion ? 'reduced' : 'full'
}

/**
 * The resolved preference does not get the last word either — WebGL2 does.
 *
 * Kept pure and exported so the whole table can be asserted without a GPU or a
 * media query. Note that a reduced-motion user lands on `still`, not on the
 * fallback: `uStill` damps flow, warp and ripples to nothing, so there is no
 * motion left to remove, and the surface goes on reporting density and colour.
 * That was settled at the shader in Phase 2 — stillness removes motion, never
 * information — and dropping those users to the gradient would take the report
 * away from them for no gain they asked for.
 */
export function resolveMode(
  setting: EffectsSetting,
  reducedMotion: boolean,
  webgl2: boolean,
): SurfaceMode {
  const effects = resolveEffects(setting, reducedMotion)
  if (!webgl2 || effects === 'off') return 'fallback'
  return effects === 'reduced' ? 'still' : 'shader'
}

/** Alpha of the tinted outer shadow. Dark enough to seat a card, not to fog it. */
const SHADOW_ALPHA = 0.62

export class AppSurface {
  readonly root: HTMLElement

  private readonly canvas: HTMLCanvasElement
  private readonly fallback: HTMLElement
  private readonly surface: Surface | null
  private readonly palette: Palette

  private mode: SurfaceMode | null = null
  private pressure = 0
  private heat = 0
  private first = true

  /** The last `--glass-tint` written, so an unchanged one is not written again. */
  private tint = ''

  /** The last inputs, so the media query can re-resolve without the store. */
  private setting: EffectsSetting = 'auto'

  private readonly motion: MediaQueryList | null

  constructor(host: HTMLElement, palette: Palette = DEFAULT_PALETTE) {
    this.palette = palette
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'surface-canvas'
    this.fallback = document.createElement('div')
    this.fallback.className = 'still-fallback'

    // aria-hidden, not just decorative-by-omission: the surface says something,
    // and what it says reaches a screen reader through the header's word and
    // the live summary. A canvas announced as "canvas" adds a stop on the way
    // to the task list and no information at all.
    this.root = document.createElement('div')
    this.root.className = 'still-surface'
    this.root.setAttribute('aria-hidden', 'true')
    this.root.append(this.canvas, this.fallback)
    host.prepend(this.root)

    // A blocked or exhausted GPU can throw here rather than returning null, and
    // a page that fails to boot because the background could not start is a
    // worse outcome than a page with a gradient behind it.
    let created: Surface | null = null
    try {
      created = Surface.create(this.canvas)
    } catch {
      created = null
    }
    this.surface = created
    this.surface?.setPalette(palette)

    globalThis.addEventListener(RIPPLE_EVENT, this.onRipple as EventListener)

    // Listened to, not merely read at boot. A user who turns reduced motion on
    // while the app is open has asked for the motion to stop now, and a
    // preference that only takes effect on the next reload is one they have to
    // discover is a reload away.
    this.motion = globalThis.matchMedia?.(REDUCED_MOTION) ?? null
    this.motion?.addEventListener('change', this.onMotionChange)
  }

  /** True when the shader is available at all, whatever the preference says. */
  get hasShader(): boolean {
    return this.surface !== null
  }

  /**
   * The renderer's own frame counters, or null in fallback mode.
   *
   * Read by the performance harness (`docs/performance.md`) and by nothing in
   * the app: these are measurements, not state, and putting them on screen
   * would mean reading them every frame.
   */
  get stats(): SurfaceStats | null {
    return this.surface?.stats ?? null
  }

  get currentMode(): SurfaceMode {
    return this.mode ?? 'fallback'
  }

  /**
   * The whole wiring, in one call per store change.
   *
   * The first call snaps rather than eases. Everywhere else the two-second
   * approach is the point — adding a task should read as the tide turning —
   * but on first paint there is nothing to ease *from*, and easing anyway
   * means a user with nine overdue tasks watches their backlog arrive as an
   * animation, which reads as a loading state for something that has already
   * loaded.
   */
  apply(summary: PressureSummary, effects: EffectsSetting): void {
    this.pressure = summary.pressure
    this.heat = summary.heat
    this.setting = effects

    const mode = resolveMode(effects, this.prefersReducedMotion, this.surface !== null)
    if (mode !== this.mode) this.setMode(mode)

    /*
     * The shadow follows heat in every mode, fallback included: the chrome has
     * to look like it is sitting on whatever is behind it, and in fallback mode
     * what is behind it is the same ramp.
     *
     * Written only when the resolved colour actually changes. A custom property
     * on `:root` invalidates every rule that reads it, so this is a
     * document-wide style recalc — cheap once, not cheap on every render.
     * `apply` is called per store change rather than per frame (the two-second
     * ease happens inside the renderer, off the main thread's style system, and
     * this reads the *target* heat), so it was never a per-frame write; but a
     * burst of edits still produced one invalidation each, measured at 60 in
     * 44ms across 30 quick-adds, every one of them the same value. String
     * equality is the right test rather than an epsilon on heat: the string is
     * the resolved 8-bit colour, so two heats that round to the same rgb triple
     * are the same paint, and anything that survives this comparison is a
     * change someone could actually see.
     */
    const tint = shadowTintCSS(this.heat, SHADOW_ALPHA, this.palette)
    if (tint !== this.tint) {
      this.tint = tint
      document.documentElement.style.setProperty('--glass-tint', tint)
    }

    if (this.surface) {
      this.surface.setTargets(this.pressure, this.heat)
      if (this.first) this.surface.snapToTargets()
    }
    if (mode === 'fallback') paintFallback(this.fallback, this.pressure, this.heat, this.palette)

    this.first = false
  }

  /**
   * Fire a ripple at a point in viewport coordinates.
   *
   * Ignored in fallback mode, where there is nothing to displace, and in
   * `still`, where the shader damps ripples to nothing anyway — asking for one
   * there would only wake the idle throttle to draw a frame identical to the
   * last.
   */
  ripple(clientX: number, clientY: number, strength = 1): void {
    if (this.mode !== 'shader') return
    this.surface?.rippleAtClient(clientX, clientY, strength)
  }

  /** True while the OS is asking for less motion. */
  get prefersReducedMotion(): boolean {
    return this.motion?.matches ?? false
  }

  dispose(): void {
    globalThis.removeEventListener(RIPPLE_EVENT, this.onRipple as EventListener)
    this.motion?.removeEventListener('change', this.onMotionChange)
    this.surface?.dispose()
    this.root.remove()
  }

  private setMode(mode: SurfaceMode): void {
    this.mode = mode
    // On the host rather than in a field alone: it is the one piece of state
    // here that is worth being able to see from outside, whether that is a
    // stylesheet, a test, or someone in devtools asking why the background is
    // not moving.
    this.root.dataset.mode = mode
    const showFallback = mode === 'fallback'
    this.fallback.hidden = !showFallback
    this.canvas.hidden = showFallback

    if (showFallback) {
      // Stopped, not merely hidden. A cancelled rAF is the difference between
      // "effects off" and "effects invisible but still costing a GPU".
      this.surface?.stop()
      return
    }
    this.surface?.setStill(mode === 'still' ? 1 : 0)
    this.surface?.start()
  }

  /**
   * Re-resolve against the last inputs. Only the mode can have changed — the
   * backlog is exactly where it was — so this deliberately does not touch the
   * pressure and heat targets and cannot restart the ease.
   */
  private readonly onMotionChange = (): void => {
    const mode = resolveMode(this.setting, this.prefersReducedMotion, this.surface !== null)
    if (mode !== this.mode) this.setMode(mode)
  }

  private readonly onRipple = (event: CustomEvent<RippleDetail>): void => {
    const d = event.detail
    if (!d) return
    this.ripple(d.x, d.y, d.strength ?? 1)
  }
}
