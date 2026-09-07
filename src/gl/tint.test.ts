/**
 * The glass tint.
 *
 * There is one thing to prove and it is not "the colour looks nice": a shadow
 * that gets lighter than the card it is under stops being a shadow and becomes
 * a halo, and heat sweeps the palette across three ramps to find that failure.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE, type RGB, rampFor } from './palette.ts'
import { shadowTint, shadowTintCSS } from './tint.ts'

/** Rec. 709 on the raw sRGB values. Relative order is all this file needs. */
function luma(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

const HEATS = Array.from({ length: 41 }, (_, i) => i / 40)

describe('shadowTint', () => {
  it('is never lighter than the surface it falls under, anywhere in the range', () => {
    for (const heat of HEATS) {
      const trough = rampFor(heat, DEFAULT_PALETTE).deep
      expect(luma(shadowTint(heat)), `heat ${heat}`).toBeLessThanOrEqual(luma(trough) + 1e-9)
    }
  })

  it('keeps the hue of the ramp rather than collapsing to neutral', () => {
    // If this ever returns grey, the shadow has stopped reporting anything and
    // could have been a hard-coded black.
    const cool = shadowTint(0)
    const warm = shadowTint(1)
    expect(cool[2]).toBeGreaterThan(cool[0]) // cool trough is blue-dominant
    expect(warm[0]).toBeGreaterThan(warm[2]) // warm trough is red-dominant
  })

  it('moves continuously — no jump at the dusk handover', () => {
    // heat 0.5 is where rampFor switches segments. A discontinuity there would
    // make the chrome flick as a single task went overdue.
    let previous = shadowTint(0)
    for (const heat of HEATS.slice(1)) {
      const next = shadowTint(heat)
      for (let i = 0; i < 3; i += 1) {
        expect(Math.abs(next[i]! - previous[i]!), `channel ${i} at ${heat}`).toBeLessThan(0.05)
      }
      previous = next
    }
  })

  it('clamps out-of-range heat rather than extrapolating past the ramp', () => {
    expect(shadowTint(-1)).toEqual(shadowTint(0))
    expect(shadowTint(2)).toEqual(shadowTint(1))
  })
})

describe('shadowTintCSS', () => {
  it('emits a colour a custom property can hold', () => {
    expect(shadowTintCSS(0, 0.62)).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.62\)$/)
  })

  it('carries its own alpha, so no color-mix is needed at the use site', () => {
    expect(shadowTintCSS(1, 0.5)).toContain('/ 0.5')
  })
})
