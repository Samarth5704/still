import { describe, expect, it } from 'vitest'
import { SETTLE_TAU, approach } from './smoothing.ts'

describe('approach', () => {
  it('does nothing without elapsed time', () => {
    expect(approach(0.2, 0.9, 0)).toBe(0.2)
  })

  it('moves toward the target without overshooting', () => {
    let v = 0
    for (let i = 0; i < 600; i += 1) {
      const next = approach(v, 1, 1 / 60)
      expect(next).toBeGreaterThan(v)
      expect(next).toBeLessThanOrEqual(1)
      v = next
    }
    expect(v).toBeCloseTo(1, 5)
  })

  it('is frame-rate independent', () => {
    let slow = 0
    let fast = 0
    for (let i = 0; i < 10; i += 1) slow = approach(slow, 1, 0.1)
    for (let i = 0; i < 60; i += 1) fast = approach(fast, 1, 1 / 60)
    expect(fast).toBeCloseTo(slow, 12)
  })

  it('settles within about two seconds', () => {
    let v = 0
    for (let i = 0; i < 120; i += 1) v = approach(v, 1, 1 / 60)
    expect(v).toBeGreaterThan(0.97)
  })

  it('falls to the target from above too', () => {
    expect(approach(1, 0, 10 * SETTLE_TAU)).toBeCloseTo(0, 4)
  })
})
