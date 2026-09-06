/**
 * The contrast model, and the thing that keeps it honest.
 *
 * `gl/contrast.ts` is a bound on what the fragment shader can do to the
 * palette, written as constants copied out of the GLSL. A copy is only as good
 * as the thing that notices when it stops matching, so the last suite here
 * reads `surface.frag.glsl` and asserts every constant is still the one in the
 * shader. Editing the shader's arithmetic without editing the model would
 * otherwise leave the contrast gate passing a stylesheet the surface can eat.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  AA_TEXT,
  DIFFUSE,
  DITHER,
  FRESNEL_GAIN,
  LEVEL,
  NOISE_MAX,
  RELIEF,
  RIPPLE_FOAM_GAIN,
  SPECULAR,
  VIGNETTE,
  composite,
  contrastRatio,
  relativeLuminance,
  saturate,
  shininess,
  surfaceExtremes,
} from './contrast.ts'
import { DEFAULT_PALETTE, rampFor, shade } from './palette.ts'
import type { RGB } from './palette.ts'

const BLACK: RGB = [0, 0, 0]
const WHITE: RGB = [1, 1, 1]

describe('WCAG arithmetic', () => {
  it('puts black and white 21:1 apart', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5)
  })

  it('is order-independent', () => {
    const a: RGB = [0.2, 0.4, 0.6]
    expect(contrastRatio(a, WHITE)).toBeCloseTo(contrastRatio(WHITE, a), 10)
  })

  it('gives a colour no contrast with itself', () => {
    expect(contrastRatio([0.3, 0.3, 0.3], [0.3, 0.3, 0.3])).toBeCloseTo(1, 10)
  })

  it('uses the sRGB transfer function, not a naive square', () => {
    // Mid grey is 0.216 relative luminance, not 0.25. Getting this wrong makes
    // every dark-theme check look about half a point better than it is.
    expect(relativeLuminance([0.5, 0.5, 0.5])).toBeCloseTo(0.2140, 3)
  })

  it('knows 4.5:1 is the body-text bar', () => {
    expect(AA_TEXT).toBe(4.5)
  })
})

describe('compositing', () => {
  it('at alpha 1 is the foreground and at 0 is the backdrop', () => {
    expect(composite(WHITE, 1, BLACK)).toEqual([1, 1, 1])
    expect(composite(WHITE, 0, BLACK)).toEqual([0, 0, 0])
  })

  it('at the scrim floor still lets the surface through', () => {
    // 0.82 of a near-black glass over white leaves 18% of the crest showing.
    // If this ever came out as pure glass the whole sweep would be vacuous.
    const under = composite([0, 0, 0], 0.82, WHITE)
    expect(under[0]).toBeCloseTo(0.18, 6)
  })

  it('leaves grey alone under saturate and pushes colour apart', () => {
    const grey: RGB = [0.5, 0.5, 0.5]
    const out = saturate(grey, 1.4)
    for (const channel of out) expect(channel).toBeCloseTo(0.5, 6)

    const teal: RGB = [0.1, 0.44, 0.49]
    const boosted = saturate(teal, 1.4)
    expect(boosted[2]).toBeGreaterThan(teal[2])
    expect(boosted[0]).toBeLessThan(teal[0])
  })

  it('clamps rather than letting saturate run off the end of the range', () => {
    for (const channel of saturate([0, 0.9, 1], 1.4)) {
      expect(channel).toBeGreaterThanOrEqual(0)
      expect(channel).toBeLessThanOrEqual(1)
    }
  })
})

describe('the surface at its extremes', () => {
  it('brackets the plain ramp colour at every corner of the space', () => {
    // The bound has to contain what the shader actually paints. `shade` at the
    // surface's resting level, unlit, is a colour the shader can definitely
    // produce, so it must lie between the two extremes in luminance.
    for (const pressure of [0, 0.5, 1]) {
      for (const heat of [0, 0.5, 1]) {
        const { brightest, darkest } = surfaceExtremes(pressure, heat, DEFAULT_PALETTE)
        const level = LEVEL[0] + (LEVEL[1] - LEVEL[0]) * pressure
        const resting = relativeLuminance(shade(rampFor(heat), level))
        expect(relativeLuminance(darkest)).toBeLessThanOrEqual(resting)
        expect(relativeLuminance(brightest)).toBeGreaterThanOrEqual(resting)
      }
    }
  })

  it('is calmer at rest than under load', () => {
    // The reason the script sweeps a grid instead of checking one hot corner:
    // pressure, not heat, decides how far the surface can swing.
    const calm = surfaceExtremes(0, 1, DEFAULT_PALETTE)
    const busy = surfaceExtremes(1, 1, DEFAULT_PALETTE)
    expect(relativeLuminance(calm.brightest)).toBeLessThan(relativeLuminance(busy.brightest))
  })

  it('never leaves the 0..1 range the framebuffer can hold', () => {
    for (let p = 0; p <= 1; p += 0.25) {
      for (let h = 0; h <= 1; h += 0.25) {
        const { brightest, darkest } = surfaceExtremes(p, h, DEFAULT_PALETTE)
        for (const channel of [...brightest, ...darkest]) {
          expect(channel).toBeGreaterThanOrEqual(0)
          expect(channel).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('reaches its brightest somewhere warm and its darkest somewhere cool', () => {
    // Heat drives the ramp, so the hottest, busiest list is the brightest thing
    // the surface can be, and the calmest, coolest one the darkest.
    const hot = relativeLuminance(surfaceExtremes(1, 1).brightest)
    const cool = relativeLuminance(surfaceExtremes(1, 0).brightest)
    expect(hot).toBeGreaterThan(cool)
  })

  it('sharpens the specular as the list gets late', () => {
    expect(shininess(0)).toBe(20)
    expect(shininess(1)).toBe(96)
    expect(shininess(0.5)).toBe(58)
  })
})

/*
 * The drift guard.
 *
 * Every number in `contrast.ts` is a transcription of a line of GLSL. Nothing
 * in the type system connects them, so this reads the shader and checks the
 * transcription. A failure here does not mean the model is wrong — it means the
 * shader moved and the model has not been told.
 */
describe('the model still matches the shader', () => {
  const glsl = readFileSync(fileURLToPath(new URL('./surface.frag.glsl', import.meta.url)), 'utf8')

  /** The two ends of a `mix(a, b, x)` call, found by the expression it feeds. */
  function mixArgs(assignment: string): [number, number] {
    const pattern = new RegExp(`${assignment}\\s*=\\s*mix\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)`)
    const m = pattern.exec(glsl)
    expect(m, `no mix() for ${assignment} in the shader`).not.toBeNull()
    return [Number(m![1]), Number(m![2])]
  }

  it('reads the same level and relief ranges', () => {
    expect(mixArgs('float level')).toEqual([...LEVEL])
    expect(mixArgs('float relief')).toEqual([...RELIEF])
  })

  it('reads the same specular gain and shininess', () => {
    expect(mixArgs('float shininess')).toEqual([20, 96])
    // `specular` is a pow() times a mix(), so the mix is matched on its own.
    expect(glsl).toContain(`mix(${SPECULAR[0].toFixed(2)}, ${SPECULAR[1].toFixed(2)}, heat)`)
  })

  it('reads the same diffuse wrap and foam gains', () => {
    expect(glsl).toContain(`color *= ${DIFFUSE[0].toFixed(2)} + ${DIFFUSE[1].toFixed(2)} * diffuse`)
    expect(glsl).toContain(`fresnel * ${FRESNEL_GAIN.toFixed(2)}`)
    expect(glsl).toContain(`* ${RIPPLE_FOAM_GAIN.toFixed(2)}`)
  })

  it('reads the same vignette and dither', () => {
    expect(glsl).toContain(`1.0 - ${VIGNETTE.toFixed(2)} * dot(p, p)`)
    expect(glsl).toContain('/ 65535.0 - 0.5) / 255.0')
    expect(DITHER).toBeCloseTo(0.5 / 255, 10)
  })

  it('reads the same light direction and half-vector construction', () => {
    expect(glsl).toContain('normalize(vec3(-0.32, 0.55, 0.77))')
    expect(glsl).toContain('normalize(lightDir + vec3(0.0, 0.0, 1.0))')
  })

  it('bounds the noise by the amplitudes the fBm actually uses', () => {
    // amp starts at 0.55 and halves each octave, over at most four octaves.
    expect(glsl).toMatch(/float amp\s*=\s*0\.55/)
    expect(glsl).toMatch(/amp \*= 0\.5/)
    expect(glsl).toMatch(/i < 4/)
    expect(NOISE_MAX).toBeCloseTo(0.55 * (1 + 0.5 + 0.25 + 0.125), 10)
  })

  it('mixes the ripple into the height at the weight the model assumes', () => {
    expect(glsl).toContain('ring.x * 0.55')
  })
})
