import { describe, expect, it } from 'vitest'
import { COOL, DUSK, WARM, fromHex, rampFloats, rampFor, shade, toCSS, toHex } from './palette.ts'

describe('rampFor', () => {
  it('is the cool ramp with nothing overdue', () => {
    expect(rampFor(0)).toEqual(COOL)
  })

  it('is the warm ramp with everything overdue', () => {
    expect(rampFor(1)).toEqual(WARM)
  })

  it('clamps out-of-range heat rather than extrapolating off the palette', () => {
    expect(rampFor(-3)).toEqual(COOL)
    expect(rampFor(12)).toEqual(WARM)
  })

  it('passes through dusk at half heat', () => {
    expect(rampFor(0.5)).toEqual(DUSK)
  })

  it('never desaturates to grey on the way from cool to warm', () => {
    // The reason DUSK exists: a straight cool-to-warm mix has a grey midpoint.
    // Every step of the real path keeps some chroma in its mid stop.
    for (let i = 0; i <= 100; i += 1) {
      const [r, g, b] = rampFor(i / 100).mid
      const chroma = Math.max(r, g, b) - Math.min(r, g, b)
      expect(chroma).toBeGreaterThan(0.06)
    }
  })
})

describe('shade', () => {
  it('hits the ramp stops exactly at 0, 0.5 and 1', () => {
    expect(shade(COOL, 0)).toEqual(COOL.deep)
    expect(shade(COOL, 0.5)).toEqual(COOL.mid)
    expect(shade(COOL, 1)).toEqual(COOL.light)
  })

  it('clamps beyond the ends', () => {
    expect(shade(COOL, -1)).toEqual(COOL.deep)
    expect(shade(COOL, 2)).toEqual(COOL.light)
  })

  it('stays inside the ramp, which is what keeps scrim contrast bounded', () => {
    for (let i = 0; i <= 100; i += 1) {
      const [r, g, b] = shade(rampFor(i / 100), i / 100)
      for (const c of [r, g, b]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('serialisation', () => {
  it('packs a ramp as vec3[4] in stop order', () => {
    const data = rampFloats(COOL)
    expect(data).toHaveLength(12)
    expect(data[0]).toBeCloseTo(COOL.deep[0], 6)
    expect(data[9]).toBeCloseTo(COOL.foam[0], 6)
  })

  it('reuses the array it is given', () => {
    const target = new Float32Array(12)
    expect(rampFloats(WARM, target)).toBe(target)
  })

  it('round-trips through hex', () => {
    for (const stop of [COOL.deep, COOL.foam, WARM.mid, WARM.light]) {
      const back = fromHex(toHex(stop))
      expect(back[0]).toBeCloseTo(stop[0], 6)
      expect(back[1]).toBeCloseTo(stop[1], 6)
      expect(back[2]).toBeCloseTo(stop[2], 6)
    }
  })

  it('rejects anything that is not #rrggbb', () => {
    expect(() => fromHex('teal')).toThrow(RangeError)
    expect(() => fromHex('#fff')).toThrow(RangeError)
  })

  it('writes CSS the fallback can use', () => {
    expect(toCSS(COOL.deep)).toBe('rgb(6 16 30)')
  })
})
