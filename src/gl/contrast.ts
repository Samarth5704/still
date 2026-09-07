/**
 * What the surface can do to the text on top of it.
 *
 * A moving background means contrast is a range, not a number. A screenshot
 * proves one pixel at one instant; what has to hold is every pixel the shader
 * can produce, at every point of the pressure and heat space, under every
 * scrim in the stylesheet. So this module answers one question — *how bright,
 * and how dark, can the surface get at a given pressure and heat?* — and
 * `scripts/contrast.ts` sweeps it into a gate.
 *
 * The answer is a BOUND, derived from the fragment shader's own arithmetic,
 * not a sample of it. Reimplementing the noise field in TypeScript would put a
 * second copy of the hardest code in the project one edit away from disagreeing
 * with the first, and sampling a GPU in CI is not a thing that works. What the
 * shader does to the palette is, however, four bounded operations — a ramp
 * lookup, a diffuse term, a specular term and a fresnel term — and every one of
 * them is a function of two things the noise only ever *supplies*: a height in
 * a known range and a unit normal. Sweep those directly and the noise itself
 * drops out of the question.
 *
 * The constants below are copied from `surface.frag.glsl` and `contrast.test.ts`
 * reads them back out of the GLSL, so the copy cannot rot quietly.
 *
 * Pure: no DOM, no globals, no clock.
 */
import { type Palette, type RGB, mixRGB, rampFor, shade } from './palette.ts'

// ---- the shader's arithmetic, as bounds -----------------------------------

/**
 * The largest magnitude four octaves of the gradient noise can reach.
 *
 * `noised` returns a value in -1..1 (the ×1.4142 in the GLSL is what normalises
 * it), and `fbm` sums four octaves at amplitudes 0.55, 0.275, 0.1375, 0.06875.
 * The true maximum of gradient noise is well under 1 and the octaves cannot all
 * peak at one point, so this is an over-estimate — which is the correct
 * direction for a floor on contrast.
 */
export const NOISE_MAX = 0.55 * (1 + 0.5 + 0.25 + 0.125)

/**
 * The tallest a ripple can stand, in the same units.
 *
 * One ring at full strength the instant it is fired. Rings from separate
 * completions do add where they cross, but they are 55ms of each other's
 * lifetime wide and the strength is 1 by construction; one is the honest
 * ceiling for a single point.
 */
export const RIPPLE_MAX = 1

/** `float level = mix(0.18, 0.54, agitation)` — where the surface rests on its ramp. */
export const LEVEL = [0.18, 0.54] as const

/** `float relief = mix(0.18, 1.00, agitation)` — how far the height field moves it. */
export const RELIEF = [0.18, 1.0] as const

/** `color *= 0.72 + 0.46 * diffuse`. */
export const DIFFUSE = [0.72, 0.46] as const

/** `float specular = pow(...) * mix(0.35, 0.75, heat)`. */
export const SPECULAR = [0.35, 0.75] as const

/** `color += foam * fresnel * 0.10` and `+ foam * clamp(ring.x, 0, 1) * 0.06`. */
export const FRESNEL_GAIN = 0.1
export const RIPPLE_FOAM_GAIN = 0.06

/** `float vignette = 1.0 - 0.28 * dot(p, p)` — 1 at the centre, less at the corners. */
export const VIGNETTE = 0.28

/** A quarter of an 8-bit step of dither, added after everything else. */
export const DITHER = 0.5 / 255

/** `vec3 lightDir = normalize(vec3(-0.32, 0.55, 0.77))`. */
const LIGHT_DIR = normalize([-0.32, 0.55, 0.77])

/** `vec3 halfway = normalize(lightDir + vec3(0, 0, 1))`. */
const HALFWAY = normalize([LIGHT_DIR[0], LIGHT_DIR[1], LIGHT_DIR[2] + 1])

type Vec3 = [number, number, number]

function normalize(v: readonly [number, number, number]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return [v[0] / len, v[1] / len, v[2] / len]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

// ---- the surface, at its extremes -----------------------------------------

export type Extremes = {
  /** The brightest pixel the surface can produce here. */
  brightest: RGB
  /** The darkest. */
  darkest: RGB
}

/**
 * How many normals to try. The surface's normal is `normalize(vec3(-slope, 1))`
 * for whatever slope the noise happens to hand it, so the honest superset is
 * the whole upward hemisphere; 48 steps of azimuth by 24 of tilt puts every
 * sample within a couple of degrees of the specular peak, which is the only
 * place on that hemisphere where the answer moves quickly.
 */
const AZIMUTH_STEPS = 48
const TILT_STEPS = 24

/**
 * The brightest and darkest colour the surface can reach at this pressure and
 * heat, in sRGB 0..1.
 *
 * Pressure — not heat — is what governs the range: `level` and `relief` both
 * rise with it, so a calm list rests near the deep end of its ramp and stays
 * there, and a busy one swings the whole way to the light stop. That is why the
 * script sweeps a grid rather than checking the hot corner and calling it done:
 * the worst case for a dark theme is a busy, late list, and the worst case for
 * a light one is a calm, clear list, and they are opposite ends of the space.
 */
export function surfaceExtremes(
  pressure: number,
  heat: number,
  palette?: Palette,
): Extremes {
  const agitation = clamp01(pressure)
  const ramp = rampFor(clamp01(heat), palette)

  const level = mix(LEVEL[0], LEVEL[1], agitation)
  const relief = mix(RELIEF[0], RELIEF[1], agitation)
  const swing = 0.5 * (NOISE_MAX + 0.55 * RIPPLE_MAX) * relief

  // The ramp is monotonically lighter from deep to light, so the extremes of
  // the base colour are the extremes of `t`.
  const base = {
    high: shade(ramp, clamp01(level + swing)),
    low: shade(ramp, clamp01(level - swing)),
  }

  const specularGain = mix(SPECULAR[0], SPECULAR[1], clamp01(heat))

  let brightest: RGB = [0, 0, 0]
  let brightestY = -1

  for (let a = 0; a < AZIMUTH_STEPS; a += 1) {
    const phi = (a / AZIMUTH_STEPS) * Math.PI * 2
    for (let t = 0; t <= TILT_STEPS; t += 1) {
      // Tilt from straight up to the horizon. The field's slopes are far
      // gentler than this at any pressure, so the sweep is a superset.
      const theta = (t / TILT_STEPS) * (Math.PI / 2)
      const n: Vec3 = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)]

      const diffuse = clamp01(dot(n, LIGHT_DIR) * 0.5 + 0.5)
      const specular = Math.pow(Math.max(dot(n, HALFWAY), 0), shininess(heat)) * specularGain
      const fresnel = Math.pow(1 - clamp01(n[2]), 3)

      // Vignette is 1 at the centre of the screen, which is where the brightest
      // pixel is free to sit; the ripple's own foam term rides along with it.
      const foamGain = specular + fresnel * FRESNEL_GAIN + RIPPLE_FOAM_GAIN
      const lit = DIFFUSE[0] + DIFFUSE[1] * diffuse

      const colour: RGB = [
        clamp01(base.high[0] * lit + ramp.foam[0] * foamGain + DITHER),
        clamp01(base.high[1] * lit + ramp.foam[1] * foamGain + DITHER),
        clamp01(base.high[2] * lit + ramp.foam[2] * foamGain + DITHER),
      ]
      const y = relativeLuminance(colour)
      if (y > brightestY) {
        brightestY = y
        brightest = colour
      }
    }
  }

  // The darkest pixel is the unlit trough in the corner: no specular, no
  // fresnel, minimum diffuse, and the vignette pulling it down further.
  const dim = DIFFUSE[0] * (1 - VIGNETTE)
  const darkest: RGB = [
    clamp01(base.low[0] * dim),
    clamp01(base.low[1] * dim),
    clamp01(base.low[2] * dim),
  ]

  return { brightest, darkest }
}

/** `float shininess = mix(20.0, 96.0, heat)`. */
export function shininess(heat: number): number {
  return mix(20, 96, clamp01(heat))
}

// ---- what the chrome does to it -------------------------------------------

/**
 * `backdrop-filter: saturate(amount)`, as the SVG colour matrix browsers
 * implement it.
 *
 * Blur is deliberately not modelled: an average of a set of colours cannot fall
 * outside that set, so blurring can only ever move the backdrop *towards* the
 * middle of the range this module already brackets. Saturation can push a
 * channel past its input, so it is applied.
 */
export function saturate(c: RGB, amount: number): RGB {
  const r = 0.213
  const g = 0.715
  const b = 0.072
  const k = amount
  return [
    clamp01((r + (1 - r) * k) * c[0] + (g - g * k) * c[1] + (b - b * k) * c[2]),
    clamp01((r - r * k) * c[0] + (g + (1 - g) * k) * c[1] + (b - b * k) * c[2]),
    clamp01((r - r * k) * c[0] + (g - g * k) * c[1] + (b + (1 - b) * k) * c[2]),
  ]
}

/** `fg` at `alpha` painted over `bg`, in sRGB — which is what the browser does. */
export function composite(fg: RGB, alpha: number, bg: RGB): RGB {
  return mixRGB(bg, fg, clamp01(alpha))
}

// ---- WCAG ------------------------------------------------------------------

/** One sRGB channel, linearised. */
function linear(channel: number): number {
  const c = clamp01(channel)
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(c: RGB): number {
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2])
}

/** WCAG 2.1 contrast ratio, 1..21, order-independent. */
export function contrastRatio(a: RGB, b: RGB): number {
  const ya = relativeLuminance(a)
  const yb = relativeLuminance(b)
  const light = Math.max(ya, yb)
  const dark = Math.min(ya, yb)
  return (light + 0.05) / (dark + 0.05)
}

/** Body text, WCAG AA. */
export const AA_TEXT = 4.5

/** Large text and non-text UI, WCAG AA. */
export const AA_LARGE = 3
