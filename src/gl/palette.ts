/**
 * The palette, in TypeScript, as the single source of truth.
 *
 * The fragment shader receives these stops as uniforms rather than hard-coding
 * them, so this module and the GLSL can never drift. That matters twice over:
 * the CSS fallback has to look like the same product as the shader, and the
 * contrast script in Phase 8 has to be able to sample the exact colours that
 * will end up behind text without reading pixels off a GPU.
 *
 * Values are sRGB in 0..1 — the same space the shader writes to the default
 * framebuffer — so `shade()` here and `shade()` in the GLSL agree numerically.
 * Pure: no DOM, no globals.
 */

/** sRGB, 0..1, not premultiplied. */
export type RGB = readonly [number, number, number]

/**
 * Four stops from trough to crest. `foam` is the specular/highlight colour and
 * is never used as a large flat area, which is why it may be much lighter than
 * the rest of the ramp without breaking contrast under a scrim.
 */
export type Ramp = {
  deep: RGB
  mid: RGB
  light: RGB
  foam: RGB
}

/** Nothing overdue: deep indigo through teal. */
export const COOL: Ramp = {
  deep: rgb8(6, 16, 30),
  mid: rgb8(12, 56, 76),
  light: rgb8(28, 112, 124),
  foam: rgb8(134, 224, 214),
}

/**
 * Half overdue. This ramp exists because interpolating teal straight to
 * oxblood passes through grey: the two are near-opposite hues, so the midpoint
 * of a componentwise mix is desaturated mud. Half your load being late is a
 * common state and it has to look like heating up, not like the screen died.
 * Routing through plum keeps the path saturated the whole way.
 */
export const DUSK: Ramp = {
  deep: rgb8(18, 12, 34),
  mid: rgb8(62, 26, 68),
  light: rgb8(132, 58, 90),
  foam: rgb8(242, 172, 196),
}

/** Everything overdue: oxblood through amber. */
export const WARM: Ramp = {
  deep: rgb8(24, 10, 12),
  mid: rgb8(84, 22, 20),
  light: rgb8(160, 68, 20),
  foam: rgb8(255, 198, 112),
}

/** The three stops heat travels through. */
export type Palette = {
  cool: Ramp
  dusk: Ramp
  warm: Ramp
}

export const DEFAULT_PALETTE: Palette = { cool: COOL, dusk: DUSK, warm: WARM }

function rgb8(r: number, g: number, b: number): RGB {
  return [r / 255, g / 255, b / 255]
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t)
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

export function mixRamp(a: Ramp, b: Ramp, t: number): Ramp {
  return {
    deep: mixRGB(a.deep, b.deep, t),
    mid: mixRGB(a.mid, b.mid, t),
    light: mixRGB(a.light, b.light, t),
    foam: mixRGB(a.foam, b.foam, t),
  }
}

/**
 * Heat, and only heat, chooses the ramp. Pressure moves the surface, not its
 * colour. Mirrored exactly in the GLSL: two linear segments through DUSK.
 */
export function rampFor(heat: number, palette: Palette = DEFAULT_PALETTE): Ramp {
  const t = clamp01(heat)
  return t < 0.5
    ? mixRamp(palette.cool, palette.dusk, t * 2)
    : mixRamp(palette.dusk, palette.warm, (t - 0.5) * 2)
}

/**
 * Height (0 = trough, 1 = crest) to base colour. Deliberately two linear
 * segments rather than a smooth spline: the GLSL mirror is three lines, and a
 * piecewise-linear ramp is trivial to sample exhaustively for contrast.
 */
export function shade(ramp: Ramp, height: number): RGB {
  const t = clamp01(height)
  return t < 0.5 ? mixRGB(ramp.deep, ramp.mid, t * 2) : mixRGB(ramp.mid, ramp.light, (t - 0.5) * 2)
}

/** `rgb(6 16 30)` — for CSS custom properties. */
export function toCSS(c: RGB): string {
  const to8 = (n: number): number => Math.round(clamp01(n) * 255)
  return `rgb(${to8(c[0])} ${to8(c[1])} ${to8(c[2])})`
}

/** Packed as vec3[4] for `uniform3fv`, in ramp order: deep, mid, light, foam. */
export function rampFloats(ramp: Ramp, into = new Float32Array(12)): Float32Array {
  const stops: RGB[] = [ramp.deep, ramp.mid, ramp.light, ramp.foam]
  for (let i = 0; i < stops.length; i += 1) {
    const c = stops[i]!
    into[i * 3] = c[0]
    into[i * 3 + 1] = c[1]
    into[i * 3 + 2] = c[2]
  }
  return into
}

/** '#0c384c' — for `<input type="color">`, which accepts nothing else. */
export function toHex(c: RGB): string {
  const to8 = (n: number): string =>
    Math.round(clamp01(n) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to8(c[0])}${to8(c[1])}${to8(c[2])}`
}

export function fromHex(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new RangeError(`not a #rrggbb colour: ${hex}`)
  const n = Number.parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
