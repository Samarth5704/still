import { describe, expect, it } from 'vitest'
import { RIPPLE_LIFETIME, RIPPLE_SLOTS, RippleBuffer } from './ripples.ts'

function slot(data: Float32Array, i: number): number[] {
  return [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!, data[i * 4 + 3]!]
}

describe('RippleBuffer', () => {
  it('starts inert', () => {
    const data = new RippleBuffer().writeInto(new Float32Array(RIPPLE_SLOTS * 4), 0)
    expect([...data].filter((_, i) => i % 4 === 3)).toEqual(Array(RIPPLE_SLOTS).fill(0))
  })

  it('writes an added ripple into the first slot', () => {
    const buffer = new RippleBuffer()
    buffer.add(0.25, -0.5, 3, 0.75)
    const data = buffer.writeInto(new Float32Array(RIPPLE_SLOTS * 4), 3)
    expect(slot(data, 0)).toEqual([0.25, -0.5, 3, 0.75])
  })

  it('fills every slot before reusing one', () => {
    const buffer = new RippleBuffer()
    for (let i = 0; i < RIPPLE_SLOTS; i += 1) buffer.add(i / 10, 0, 0, 1)
    const data = buffer.writeInto(new Float32Array(RIPPLE_SLOTS * 4), 0)
    for (let i = 0; i < RIPPLE_SLOTS; i += 1) expect(data[i * 4]).toBeCloseTo(i / 10)
  })

  it('overwrites the oldest when a ninth arrives', () => {
    const buffer = new RippleBuffer()
    for (let i = 0; i < RIPPLE_SLOTS; i += 1) buffer.add(i, 0, 0, 1)
    buffer.add(99, 0, 0, 1)
    const data = buffer.writeInto(new Float32Array(RIPPLE_SLOTS * 4), 0)
    expect(data[0]).toBe(99)
    expect(data[4]).toBe(1) // the second-oldest is untouched
  })

  it('zeroes strength once a ripple has outlived its lifetime', () => {
    const buffer = new RippleBuffer()
    buffer.add(0, 0, 0, 1)
    const data = new Float32Array(RIPPLE_SLOTS * 4)

    buffer.writeInto(data, RIPPLE_LIFETIME - 0.01)
    expect(data[3]).toBe(1)

    buffer.writeInto(data, RIPPLE_LIFETIME + 0.01)
    expect(data[3]).toBe(0)
  })

  it('counts only live ripples', () => {
    const buffer = new RippleBuffer()
    buffer.add(0, 0, 0, 1)
    buffer.add(0, 0, 1, 1)
    expect(buffer.activeCount(0)).toBe(1)
    expect(buffer.activeCount(1)).toBe(2)
    expect(buffer.activeCount(2)).toBe(1)
    expect(buffer.activeCount(5)).toBe(0)
  })

  it('clears', () => {
    const buffer = new RippleBuffer()
    buffer.add(0, 0, 0, 1)
    buffer.clear()
    expect(buffer.activeCount(0)).toBe(0)
  })
})
