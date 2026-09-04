/**
 * Frame-rate-independent easing toward a target.
 *
 * Adding one task should read as the tide turning, not as a jump cut, so
 * pressure and heat are never written straight to their uniforms — they chase
 * their targets exponentially. Doing this with a per-frame lerp constant would
 * make the surface settle faster on a 144Hz monitor than on a 60Hz one; the
 * exponential form depends on elapsed time only.
 */

/** Seconds. Four time constants is ~98% of the way there, so this settles in ~2.2s. */
export const SETTLE_TAU = 0.55

export function approach(current: number, target: number, dt: number, tau = SETTLE_TAU): number {
  if (dt <= 0) return current
  if (tau <= 0) return target
  return target + (current - target) * Math.exp(-dt / tau)
}

/** Within this of the target, treat a channel as settled (see the idle throttle). */
export const SETTLED_EPSILON = 0.001
