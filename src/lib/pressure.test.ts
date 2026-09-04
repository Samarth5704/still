import { describe, expect, it } from 'vitest'
import type { Priority, Task } from './types.ts'
import { K, computePressure, pressureLabel } from './pressure.ts'

const TODAY = '2026-09-04'

let seed = 0
const task = (over: Partial<Task> = {}): Task => ({
  id: `t${(seed += 1)}`,
  title: 'task',
  notes: '',
  done: false,
  completedAt: null,
  due: null,
  dueTime: null,
  priority: 'none',
  projectId: null,
  tagIds: [],
  parentId: null,
  order: 0,
  recurrenceId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

/** n identical medium tasks due today: 2.5 x 2 = 5 of load each. */
const busyTasks = (n: number): Task[] =>
  Array.from({ length: n }, () => task({ priority: 'medium', due: TODAY }))

describe('pressure', () => {
  it('is 0 for an empty list', () => {
    expect(computePressure([], TODAY)).toMatchObject({ pressure: 0, heat: 0, load: 0, openCount: 0 })
  })

  it('is 0 when everything is done', () => {
    const tasks = [
      task({ done: true, priority: 'urgent', due: '2026-01-01' }),
      task({ done: true, priority: 'high' }),
    ]
    expect(computePressure(tasks, TODAY)).toMatchObject({ pressure: 0, heat: 0, openCount: 0 })
  })

  it('is near 0 for a single low-priority task with no due date', () => {
    const { pressure } = computePressure([task({ priority: 'low' })], TODAY)
    expect(pressure).toBeGreaterThan(0)
    expect(pressure).toBeLessThan(0.03)
  })

  it('applies the priority weights', () => {
    const weights: Record<Priority, number> = {
      none: 1,
      low: 1.5,
      medium: 2.5,
      high: 4,
      urgent: 6,
    }
    for (const [priority, weight] of Object.entries(weights) as [Priority, number][]) {
      expect(computePressure([task({ priority })], TODAY).load).toBeCloseTo(weight, 10)
    }
  })

  it('applies the urgency multipliers', () => {
    // priority 'none' weighs 1, so load reads out as the multiplier itself.
    const load = (due: string | null): number => computePressure([task({ due })], TODAY).load
    expect(load('2026-09-03')).toBeCloseTo(2 + 1 / 7, 10) // 1 day overdue
    expect(load('2026-08-28')).toBeCloseTo(3, 10) // 7 days overdue
    expect(load('2026-08-21')).toBeCloseTo(4, 10) // 14 days overdue
    expect(load('2026-08-05')).toBeCloseTo(4, 10) // 30 days: capped at 14
    expect(load(TODAY)).toBeCloseTo(2, 10)
    expect(load('2026-09-05')).toBeCloseTo(1.5, 10)
    expect(load('2026-09-07')).toBeCloseTo(1.5, 10) // 3 days out
    expect(load('2026-09-08')).toBeCloseTo(1.1, 10) // 4 days out
    expect(load(null)).toBeCloseTo(1, 10)
  })

  it('increases strictly with every task added, whatever its priority', () => {
    const priorities: Priority[] = ['none', 'low', 'medium', 'high', 'urgent']
    const tasks: Task[] = []
    let previous = 0
    for (const priority of priorities) {
      tasks.push(task({ priority }))
      const { pressure } = computePressure(tasks, TODAY)
      expect(pressure).toBeGreaterThan(previous)
      previous = pressure
    }
  })

  it('saturates: the marginal task matters less as the list grows', () => {
    // The real invariant. 1 - exp(-L/k) is concave, so this holds everywhere on
    // the curve — unlike the doubling comparison below, which needs its sizes chosen.
    let previousDelta = Infinity
    for (let n = 0; n < 60; n += 1) {
      const before = computePressure(busyTasks(n), TODAY).pressure
      const after = computePressure(busyTasks(n + 1), TODAY).pressure
      const delta = after - before
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBeLessThan(previousDelta)
      previousDelta = delta
    }
  })

  it('moves less when a large list doubles than when a small one does', () => {
    const at = (n: number): number => computePressure(busyTasks(n), TODAY).pressure
    const small = at(20) - at(10)
    const large = at(200) - at(100)
    expect(large).toBeLessThan(small)
    expect(small).toBeGreaterThan(0.2)
    expect(large).toBeLessThan(0.01)
  })

  it('never exceeds 1, even with 10,000 tasks', () => {
    const { pressure } = computePressure(
      Array.from({ length: 10_000 }, () => task({ priority: 'urgent', due: '2020-01-01' })),
      TODAY,
    )
    expect(Number.isFinite(pressure)).toBe(true)
    expect(pressure).toBeLessThanOrEqual(1)
    expect(pressure).toBeGreaterThan(0.999)
  })

  it('excludes subtasks: a checklist is one commitment, not twenty', () => {
    const parent = task({ id: 'p', priority: 'high', due: TODAY })
    const children = Array.from({ length: 20 }, () =>
      task({ parentId: 'p', priority: 'high', due: TODAY }),
    )
    const alone = computePressure([parent], TODAY)
    const withChildren = computePressure([parent, ...children], TODAY)
    expect(withChildren.pressure).toBe(alone.pressure)
    expect(withChildren.openCount).toBe(1)
  })

  it('takes today as an explicit input rather than reading the clock', () => {
    const tasks = [task({ due: '2026-09-04', priority: 'high' })]
    const onTheDay = computePressure(tasks, '2026-09-04').pressure
    const aWeekLate = computePressure(tasks, '2026-09-11').pressure
    expect(aWeekLate).toBeGreaterThan(onTheDay)
  })

  it('lands a realistic busy day near 0.6 under the chosen k', () => {
    expect(K).toBe(75)
    const day = [
      task({ priority: 'medium', due: '2026-09-01' }),
      task({ priority: 'medium', due: '2026-09-01' }),
      task({ priority: 'high', due: '2026-09-01' }),
      task({ priority: 'urgent', due: TODAY }),
      task({ priority: 'high', due: TODAY }),
      task({ priority: 'medium', due: TODAY }),
      task({ priority: 'medium', due: TODAY }),
      task({ priority: 'high', due: '2026-09-06' }),
      task({ priority: 'medium', due: '2026-09-06' }),
      task({ priority: 'low', due: '2026-09-06' }),
      task({ priority: 'medium', due: '2026-09-20' }),
      task({ priority: 'low', due: '2026-09-20' }),
      task({ priority: 'none' }),
      task({ priority: 'none' }),
    ]
    const { pressure } = computePressure(day, TODAY)
    expect(pressure).toBeGreaterThan(0.55)
    expect(pressure).toBeLessThan(0.65)
  })
})

describe('heat', () => {
  it('is 0 with nothing overdue', () => {
    const tasks = [task({ due: TODAY, priority: 'urgent' }), task({ due: '2026-09-20' })]
    expect(computePressure(tasks, TODAY).heat).toBe(0)
  })

  it('is 1 when everything is overdue', () => {
    const tasks = [task({ due: '2026-09-01' }), task({ due: '2026-08-01', priority: 'high' })]
    expect(computePressure(tasks, TODAY).heat).toBe(1)
  })

  it('is exactly 0.5 when overdue and current load are equal', () => {
    // 'none' at 14+ days overdue contributes 1 x 4; 'high' undated contributes 4 x 1.
    const tasks = [task({ due: '2026-08-01' }), task({ priority: 'high' })]
    const { heat, load } = computePressure(tasks, TODAY)
    expect(load).toBeCloseTo(8, 10)
    expect(heat).toBeCloseTo(0.5, 10)
  })

  it('weighs load, not head count', () => {
    const tasks = [
      task({ priority: 'urgent', due: '2026-08-01' }), // 1 of 4 tasks
      task(),
      task(),
      task(),
    ]
    const { heat } = computePressure(tasks, TODAY)
    expect(heat).toBeCloseTo(24 / 27, 10)
    expect(heat).toBeGreaterThan(0.5)
  })

  it('is 0 rather than NaN on an empty list', () => {
    const { heat } = computePressure([], TODAY)
    expect(Number.isNaN(heat)).toBe(false)
    expect(heat).toBe(0)
  })

  it('never counts a done task as overdue', () => {
    const tasks = [task({ done: true, due: '2026-01-01' }), task({ due: '2026-09-20' })]
    const { heat, overdueCount } = computePressure(tasks, TODAY)
    expect(heat).toBe(0)
    expect(overdueCount).toBe(0)
  })

  it('counts overdue tasks for the text equivalent', () => {
    const tasks = [
      task({ due: '2026-09-01' }),
      task({ due: '2026-09-02' }),
      task({ due: TODAY }),
      task({ parentId: 'p', due: '2026-01-01' }),
    ]
    expect(computePressure(tasks, TODAY).overdueCount).toBe(2)
  })
})

describe('pressureLabel', () => {
  it('names each band at its boundaries', () => {
    expect(pressureLabel(0)).toBe('Calm')
    expect(pressureLabel(0.1499)).toBe('Calm')
    expect(pressureLabel(0.15)).toBe('Steady')
    expect(pressureLabel(0.3999)).toBe('Steady')
    expect(pressureLabel(0.4)).toBe('Busy')
    expect(pressureLabel(0.6999)).toBe('Busy')
    expect(pressureLabel(0.7)).toBe('Heavy')
    expect(pressureLabel(1)).toBe('Heavy')
  })
})
