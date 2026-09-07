/**
 * The colour the chrome borrows from the surface underneath it.
 *
 * Phase 7 asks for "a soft outer shadow tinted from the surface below". The
 * honest reading of that is not a screenshot of the shader — sampling the
 * framebuffer to style the DOM would put a GPU readback in front of every
 * paint, which is the whole reason liquid-glass-js was studied and not
 * imported. It is the palette: heat already decides which ramp the surface is
 * on, and `palette.ts` is the source of truth for that ramp on both sides of
 * the WebGL boundary. So the shadow is derived from the same numbers the
 * fragment shader is being handed, and it moves when the surface moves without
 * ever reading a pixel.
 *
 * Pure: no DOM, no globals, no clock.
 */
import { type Palette, type RGB, mixRGB, rampFor } from './palette.ts'

/**
 * How far the trough colour is pulled toward black.
 *
 * A shadow has to be darker than the thing it falls on at every point of the
 * range, and the warm ramp's trough (oxblood, 24 10 12) is already close to
 * black while the cool one (6 16 30) is closer still. Mixing toward black
 * rather than scaling keeps the hue: a late list casts a red-black shadow, a
 * clear one a blue-black shadow, and neither ever lightens what is under it.
 */
const TOWARD_BLACK = 0.4

const BLACK: RGB = [0, 0, 0]

/** The shadow's hue, from the ramp heat has put the surface on. */
export function shadowTint(heat: number, palette?: Palette): RGB {
  return mixRGB(rampFor(heat, palette).deep, BLACK, TOWARD_BLACK)
}

/**
 * `rgb(3 6 12 / 0.62)` — ready for a custom property.
 *
 * Alpha lives here rather than in the CSS because a colour with its own alpha
 * can be dropped straight into a `box-shadow` without `color-mix`, and the
 * shadow is set on `:root` where a `color-mix` would be re-resolved by every
 * glass surface on the page.
 */
export function shadowTintCSS(heat: number, alpha: number, palette?: Palette): string {
  const c = shadowTint(heat, palette)
  const to8 = (n: number): number => Math.round(Math.min(Math.max(n, 0), 1) * 255)
  return `rgb(${to8(c[0])} ${to8(c[1])} ${to8(c[2])} / ${alpha})`
}
