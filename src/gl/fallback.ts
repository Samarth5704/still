/**
 * Drives the static fallback surface from the same two numbers as the shader.
 *
 * The only DOM this touches is custom properties on one element, so switching
 * between the shader and the fallback never re-styles anything else.
 */
import './fallback.css'
import { DEFAULT_PALETTE, type Palette, rampFor, toCSS } from './palette.ts'

export function paintFallback(
  el: HTMLElement,
  pressure: number,
  heat: number,
  palette: Palette = DEFAULT_PALETTE,
): void {
  const ramp = rampFor(heat, palette)
  el.style.setProperty('--sf-deep', toCSS(ramp.deep))
  el.style.setProperty('--sf-mid', toCSS(ramp.mid))
  el.style.setProperty('--sf-light', toCSS(ramp.light))
  el.style.setProperty('--sf-foam', toCSS(ramp.foam))
  el.style.setProperty('--sf-spread', String(clamp01(pressure)))
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0
}
