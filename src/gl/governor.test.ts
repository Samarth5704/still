/**
 * The resolution governor's decision table.
 *
 * The renderer needs a GPU to run; this rule does not, and it is the part with
 * the failure modes. Two of them are worth naming: a governor that rises on any
 * cost under budget oscillates forever between two resolutions, and a governor
 * that treats a 16.7ms frame as evidence of anything mistakes vsync for load.
 */
import { describe, expect, it } from 'vitest'
import { BUDGET_MS, SCALE_STEPS, governScale } from './renderer.ts'

const LAST = SCALE_STEPS.length - 1

/** A frame that arrived on time, so wall clock says nothing either way. */
const ON_TIME = 16.7

describe('the render scale steps', () => {
  it('start at native and only ever go down from there', () => {
    expect(SCALE_STEPS[0]).toBe(1)
    for (let i = 1; i < SCALE_STEPS.length; i += 1) {
      expect(SCALE_STEPS[i]!).toBeLessThan(SCALE_STEPS[i - 1]!)
    }
  })

  it('reach far enough down to bring an integrated GPU inside the budget', () => {
    // Measured at 9.6ms per megapixel on Intel UHD 620-class hardware, so
    // 1440x900 at DPR 1.5 is 2.92Mpx and 28ms. The last step has to get that
    // under 4ms or the governor runs out of room before the budget is met.
    const pixels = 2160 * 1350 * SCALE_STEPS[LAST]! ** 2
    expect((pixels / 1e6) * 9.6).toBeLessThan(BUDGET_MS)
  })
})

describe('governScale', () => {
  it('drops a step when the GPU is over budget', () => {
    expect(governScale(0, BUDGET_MS + 1, ON_TIME)).toBe(1)
  })

  it('climbs back only with real headroom, not merely under budget', () => {
    // 3.9ms is under 4 and would still be over 4 at 1.56x the pixels. A
    // governor that rises here spends its life bouncing.
    expect(governScale(2, 3.9, ON_TIME)).toBe(0)
    expect(governScale(2, BUDGET_MS * 0.5, ON_TIME)).toBe(-1)
  })

  it('holds inside the band', () => {
    expect(governScale(2, BUDGET_MS * 0.8, ON_TIME)).toBe(0)
  })

  it('never steps past either end', () => {
    expect(governScale(0, BUDGET_MS * 0.1, ON_TIME)).toBe(0)
    expect(governScale(LAST, BUDGET_MS * 10, ON_TIME)).toBe(0)
  })

  it('falls back to dropped frames when there is no GPU timer', () => {
    // Safari has no EXT_disjoint_timer_query_webgl2, so this is not a rare path.
    expect(governScale(0, null, 32)).toBe(1)
    expect(governScale(0, null, ON_TIME)).toBe(0)
  })

  it('never climbs on wall clock alone', () => {
    // A 16.7ms frame is what vsync looks like whether the GPU used 1ms or 16.
    // Reading that as headroom would step up into a stutter and then step back.
    for (const frameMs of [4, 8, ON_TIME]) {
      expect(governScale(3, null, frameMs)).toBe(0)
    }
  })
})
