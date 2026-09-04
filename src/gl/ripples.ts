/**
 * The ripple ring buffer.
 *
 * The shader has exactly eight slots, so a ninth completion has to displace
 * something. It displaces the oldest, which is the only choice that keeps a
 * burst of fast completions looking like a burst rather than like one ripple
 * that refuses to die.
 *
 * Pure: no clock reads. `now` is passed in, as everywhere else in this project.
 */

export const RIPPLE_SLOTS = 8

/** Seconds. Must match RIPPLE_LIFETIME in surface.frag.glsl. */
export const RIPPLE_LIFETIME = 1.2

export type Ripple = {
  /** Origin in the surface's aspect-corrected clip space: y in -1..1, x in -a..a. */
  x: number
  y: number
  /** Shader clock reading at which the ripple was fired, in seconds. */
  start: number
  /** 0 = inert. */
  strength: number
}

export class RippleBuffer {
  private readonly slots: Ripple[] = Array.from({ length: RIPPLE_SLOTS }, () => ({
    x: 0,
    y: 0,
    start: 0,
    strength: 0,
  }))

  private next = 0

  add(x: number, y: number, start: number, strength = 1): void {
    const slot = this.slots[this.next]!
    slot.x = x
    slot.y = y
    slot.start = start
    slot.strength = strength
    this.next = (this.next + 1) % RIPPLE_SLOTS
  }

  /** How many are still alive at `now`. Used to decide whether the surface is idle. */
  activeCount(now: number): number {
    let n = 0
    for (const s of this.slots) {
      if (s.strength > 0 && now - s.start >= 0 && now - s.start <= RIPPLE_LIFETIME) n += 1
    }
    return n
  }

  /**
   * Pack into the vec4[8] the shader reads. Expired slots are written with
   * strength 0 so the fragment loop can skip them on its first test instead of
   * computing a distance for a ripple that finished two minutes ago.
   */
  writeInto(target: Float32Array, now: number): Float32Array {
    for (let i = 0; i < RIPPLE_SLOTS; i += 1) {
      const s = this.slots[i]!
      const age = now - s.start
      const alive = s.strength > 0 && age >= 0 && age <= RIPPLE_LIFETIME
      target[i * 4] = s.x
      target[i * 4 + 1] = s.y
      target[i * 4 + 2] = s.start
      target[i * 4 + 3] = alive ? s.strength : 0
    }
    return target
  }

  clear(): void {
    for (const s of this.slots) s.strength = 0
    this.next = 0
  }
}
