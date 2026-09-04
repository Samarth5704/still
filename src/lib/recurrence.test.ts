import { describe, expect, it } from 'vitest'
import type { Recurrence, RecurrenceException } from './types.ts'
import { occurrenceDatesBetween, occurrencesBetween, pendingOccurrenceDates } from './recurrence.ts'

const rule = (over: Partial<Recurrence> & Pick<Recurrence, 'freq' | 'starts'>): Recurrence => ({
  id: 'r1',
  interval: 1,
  ends: { type: 'never' },
  exceptions: [],
  ...over,
})

/** Dates only, for the many cases where status is not what is under test. */
const dates = (r: Recurrence, a: string, b: string, cap = 500): string[] =>
  occurrenceDatesBetween(r, a, b, cap)

describe('daily', () => {
  it('generates every day at interval 1', () => {
    const r = rule({ freq: 'daily', starts: '2026-01-01' })
    expect(dates(r, '2026-01-01', '2026-01-05')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ])
  })

  it('anchors interval 3 to starts, not to the window', () => {
    const r = rule({ freq: 'daily', starts: '2026-01-01', interval: 3 })
    const full = dates(r, '2026-01-01', '2026-02-28')
    const mid = dates(r, '2026-01-20', '2026-02-28')
    expect(mid).toEqual(full.filter((d) => d >= '2026-01-20'))
    expect(mid[0]).toBe('2026-01-22')
  })
})

describe('weekly', () => {
  it('generates a weekday set at interval 1', () => {
    const r = rule({ freq: 'weekly', starts: '2026-01-06', byWeekday: [2, 4] })
    expect(dates(r, '2026-01-01', '2026-01-31')).toEqual([
      '2026-01-06',
      '2026-01-08',
      '2026-01-13',
      '2026-01-15',
      '2026-01-20',
      '2026-01-22',
      '2026-01-27',
      '2026-01-29',
    ])
  })

  it('every other week on Tue and Thu is parity-stable across window starts', () => {
    const r = rule({
      freq: 'weekly',
      starts: '2026-01-06',
      interval: 2,
      byWeekday: [2, 4],
      weekStart: 1,
    })
    const full = dates(r, '2026-01-01', '2026-03-31')
    expect(full.slice(0, 6)).toEqual([
      '2026-01-06',
      '2026-01-08',
      '2026-01-20',
      '2026-01-22',
      '2026-02-03',
      '2026-02-05',
    ])
    for (const from of ['2025-12-01', '2026-01-06', '2026-01-21', '2026-02-14']) {
      expect(dates(r, from, '2026-03-31')).toEqual(full.filter((d) => d >= from))
    }
  })

  it('returns nothing for a window that lies entirely in an off week', () => {
    const r = rule({
      freq: 'weekly',
      starts: '2026-01-06',
      interval: 2,
      byWeekday: [2, 4],
      weekStart: 1,
    })
    expect(dates(r, '2026-01-12', '2026-01-18')).toEqual([])
  })

  it('excludes weekdays before starts in the anchor week, and they consume no seq', () => {
    // Tue 6 Jan precedes starts (Thu 8 Jan) within the same Monday-week.
    const r = rule({
      freq: 'weekly',
      starts: '2026-01-08',
      byWeekday: [2, 4],
      weekStart: 1,
      ends: { type: 'after', count: 3 },
    })
    const out = occurrencesBetween(r, '2026-01-01', '2026-12-31', 500)
    expect(out.map((o) => o.date)).toEqual(['2026-01-08', '2026-01-13', '2026-01-15'])
    expect(out.map((o) => o.seq)).toEqual([0, 1, 2])
  })

  it('defaults byWeekday to the weekday of starts', () => {
    const r = rule({ freq: 'weekly', starts: '2026-01-06' })
    expect(dates(r, '2026-01-01', '2026-01-31')).toEqual([
      '2026-01-06',
      '2026-01-13',
      '2026-01-20',
      '2026-01-27',
    ])
  })

  it('keeps Sun and Tue in one occurrence week under weekStart 0, and splits them under 1', () => {
    const base: Partial<Recurrence> & Pick<Recurrence, 'freq' | 'starts'> = {
      freq: 'weekly',
      starts: '2026-01-04',
      interval: 2,
      byWeekday: [0, 2],
    }
    expect(dates(rule({ ...base, weekStart: 0 }), '2026-01-01', '2026-02-07')).toEqual([
      '2026-01-04',
      '2026-01-06',
      '2026-01-18',
      '2026-01-20',
      '2026-02-01',
      '2026-02-03',
    ])
    expect(dates(rule({ ...base, weekStart: 1 }), '2026-01-01', '2026-02-07')).toEqual([
      '2026-01-04',
      '2026-01-13',
      '2026-01-18',
      '2026-01-27',
      '2026-02-01',
    ])
  })

  it('is unaffected by the app settings changing after the rule was created', () => {
    // The regression that matters: weekStart lives on the rule, so flipping
    // settings.weekStartsOn cannot move an existing biweekly rule.
    const r = rule({
      freq: 'weekly',
      starts: '2026-01-04',
      interval: 2,
      byWeekday: [0, 2],
      weekStart: 0,
    })
    const before = occurrencesBetween(r, '2026-01-01', '2026-03-31', 500, { weekStart: 0 })
    const after = occurrencesBetween(r, '2026-01-01', '2026-03-31', 500, { weekStart: 1 })
    expect(after).toEqual(before)
  })

  it('defaults a rule with no weekStart to Monday', () => {
    const without = rule({ freq: 'weekly', starts: '2026-01-04', interval: 2, byWeekday: [0, 2] })
    const monday = rule({
      freq: 'weekly',
      starts: '2026-01-04',
      interval: 2,
      byWeekday: [0, 2],
      weekStart: 1,
    })
    expect(dates(without, '2026-01-01', '2026-02-07')).toEqual(
      dates(monday, '2026-01-01', '2026-02-07'),
    )
  })

  it('ignores weekStart entirely at interval 1', () => {
    const base: Partial<Recurrence> & Pick<Recurrence, 'freq' | 'starts'> = {
      freq: 'weekly',
      starts: '2026-01-04',
      byWeekday: [0, 2],
    }
    expect(dates(rule({ ...base, weekStart: 0 }), '2026-01-01', '2026-02-07')).toEqual(
      dates(rule({ ...base, weekStart: 1 }), '2026-01-01', '2026-02-07'),
    )
  })
})

describe('monthly by date', () => {
  it('clamps the 31st to the last day of short months', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-31', byMonthDay: 31 })
    expect(dates(r, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  it('clamps to 29 February in a leap year', () => {
    const r = rule({ freq: 'monthly', starts: '2024-01-31', byMonthDay: 31 })
    expect(dates(r, '2024-01-01', '2024-03-31')).toEqual([
      '2024-01-31',
      '2024-02-29',
      '2024-03-31',
    ])
  })

  it('clamps the 30th in February too', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-30', byMonthDay: 30 })
    expect(dates(r, '2026-01-01', '2026-03-31')).toEqual([
      '2026-01-30',
      '2026-02-28',
      '2026-03-30',
    ])
  })

  it('never drifts: the clamp is recomputed from the rule, not the previous occurrence', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-31', byMonthDay: 31 })
    const out = dates(r, '2026-01-01', '2027-12-31')
    expect(out).toHaveLength(24)
    // Seven long months a year survive as the 31st; the drift bug would leave none after February.
    expect(out.filter((d) => d.endsWith('-31'))).toHaveLength(14)
    expect(out[13]).toBe('2027-02-28')
    expect(out[14]).toBe('2027-03-31')
  })

  it('anchors interval 2 to starts', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-15', byMonthDay: 15, interval: 2 })
    expect(dates(r, '2026-01-01', '2026-08-31')).toEqual([
      '2026-01-15',
      '2026-03-15',
      '2026-05-15',
      '2026-07-15',
    ])
    expect(dates(r, '2026-04-01', '2026-08-31')).toEqual(['2026-05-15', '2026-07-15'])
  })

  it('starts in the following month when starts is past the day of month', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-25', byMonthDay: 20 })
    expect(dates(r, '2026-01-01', '2026-03-31')).toEqual(['2026-02-20', '2026-03-20'])
  })
})

describe('monthly by nth weekday', () => {
  it('generates the 2nd Tuesday', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-01', byNthWeekday: { nth: 2, weekday: 2 } })
    expect(dates(r, '2026-01-01', '2026-06-30')).toEqual([
      '2026-01-13',
      '2026-02-10',
      '2026-03-10',
      '2026-04-14',
      '2026-05-12',
      '2026-06-09',
    ])
  })

  it('generates the last Friday, whether that is the 4th or the 5th', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-01', byNthWeekday: { nth: -1, weekday: 5 } })
    expect(dates(r, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-30', // the 5th Friday
      '2026-02-27', // the 4th
      '2026-03-27',
      '2026-04-24',
    ])
  })

  it('skips months with no 5th weekday rather than clamping', () => {
    const r = rule({ freq: 'monthly', starts: '2026-01-01', byNthWeekday: { nth: 5, weekday: 5 } })
    expect(dates(r, '2026-01-01', '2026-08-31')).toEqual([
      '2026-01-30',
      '2026-05-29',
      '2026-07-31',
    ])
  })

  it('handles the 1st of the month falling on the target weekday', () => {
    // 2026-02-01 is a Sunday.
    const r = rule({ freq: 'monthly', starts: '2026-02-01', byNthWeekday: { nth: 1, weekday: 0 } })
    expect(dates(r, '2026-02-01', '2026-03-31')).toEqual(['2026-02-01', '2026-03-01'])
  })
})

describe('yearly', () => {
  it('clamps 29 February to the 28th in common years', () => {
    const r = rule({ freq: 'yearly', starts: '2024-02-29', byMonth: 2, byMonthDay: 29 })
    expect(dates(r, '2024-01-01', '2029-12-31')).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
      '2029-02-28',
    ])
  })

  it('anchors interval 2 to starts', () => {
    const r = rule({ freq: 'yearly', starts: '2026-06-15', interval: 2 })
    expect(dates(r, '2026-01-01', '2032-12-31')).toEqual([
      '2026-06-15',
      '2028-06-15',
      '2030-06-15',
      '2032-06-15',
    ])
  })

  it('uses byMonth and byMonthDay when they differ from starts', () => {
    const r = rule({ freq: 'yearly', starts: '2026-01-10', byMonth: 12, byMonthDay: 25 })
    expect(dates(r, '2026-01-01', '2028-12-31')).toEqual([
      '2026-12-25',
      '2027-12-25',
      '2028-12-25',
    ])
  })
})

describe('bounds', () => {
  it('bounds a never-ending daily rule to the window', () => {
    const r = rule({ freq: 'daily', starts: '2020-01-01' })
    const out = dates(r, '2026-01-01', '2026-12-31', 1000)
    expect(out).toHaveLength(365)
    expect(out[0]).toBe('2026-01-01')
    expect(out.at(-1)).toBe('2026-12-31')
  })

  it('respects the cap', () => {
    const r = rule({ freq: 'daily', starts: '2020-01-01' })
    expect(dates(r, '2026-01-01', '2026-12-31', 50)).toHaveLength(50)
    expect(dates(r, '2026-01-01', '2026-12-31', 0)).toEqual([])
  })

  it('ends.after yields exactly count occurrences across a huge window', () => {
    const r = rule({ freq: 'daily', starts: '2026-01-01', ends: { type: 'after', count: 10 } })
    const out = dates(r, '2000-01-01', '2099-12-31')
    expect(out).toHaveLength(10)
    expect(out.at(-1)).toBe('2026-01-10')
  })

  it('counts ends.after from starts, not from the window', () => {
    const r = rule({ freq: 'daily', starts: '2026-01-01', ends: { type: 'after', count: 10 } })
    const mid = occurrencesBetween(r, '2026-01-05', '2026-12-31', 500)
    expect(mid.map((o) => o.date)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
    ])
    expect(mid.map((o) => o.seq)).toEqual([4, 5, 6, 7, 8, 9])
  })

  it('truncates at an until date that falls mid-window, inclusive', () => {
    const r = rule({
      freq: 'daily',
      starts: '2026-01-01',
      ends: { type: 'until', date: '2026-01-05' },
    })
    expect(dates(r, '2026-01-01', '2026-01-31')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ])
  })

  it('returns nothing for windows outside the series', () => {
    const r = rule({ freq: 'daily', starts: '2026-01-01', ends: { type: 'after', count: 5 } })
    expect(dates(r, '2025-01-01', '2025-12-31')).toEqual([])
    expect(dates(r, '2026-02-01', '2026-12-31')).toEqual([])
  })

  it('rejects a non-positive interval', () => {
    const zero = rule({ freq: 'daily', starts: '2026-01-01', interval: 0 })
    const negative = rule({ freq: 'daily', starts: '2026-01-01', interval: -2 })
    expect(() => dates(zero, '2026-01-01', '2026-01-31')).toThrow()
    expect(() => dates(negative, '2026-01-01', '2026-01-31')).toThrow()
  })

  it('rejects an inverted window', () => {
    const r = rule({ freq: 'daily', starts: '2026-01-01' })
    expect(() => dates(r, '2026-02-01', '2026-01-01')).toThrow()
  })
})

describe('exceptions', () => {
  const daily10 = (exceptions: RecurrenceException[]): Recurrence =>
    rule({ freq: 'daily', starts: '2026-01-01', ends: { type: 'after', count: 10 }, exceptions })

  it('returns skipped occurrences marked, rather than dropping them', () => {
    const r = daily10([{ date: '2026-01-03', kind: 'skipped' }])
    const out = occurrencesBetween(r, '2026-01-01', '2026-01-31', 500)
    expect(out.find((o) => o.date === '2026-01-03')).toMatchObject({ seq: 2, status: 'skipped' })
    expect(pendingOccurrenceDates(r, '2026-01-01', '2026-01-31', 500)).not.toContain('2026-01-03')
  })

  it('lets a skip consume one of the count: the series still ends on the 10th date', () => {
    const out = occurrencesBetween(
      daily10([
        { date: '2026-01-02', kind: 'skipped' },
        { date: '2026-01-05', kind: 'skipped' },
        { date: '2026-01-09', kind: 'skipped' },
      ]),
      '2026-01-01',
      '2026-12-31',
      500,
    )
    expect(out).toHaveLength(10)
    expect(out.at(-1)?.date).toBe('2026-01-10')
    expect(out.filter((o) => o.status === 'skipped')).toHaveLength(3)
    expect(out.filter((o) => o.status === 'pending')).toHaveLength(7)
  })

  it('terminates when every occurrence is skipped', () => {
    const all: RecurrenceException[] = Array.from({ length: 10 }, (_, i) => ({
      date: '2026-01-' + String(i + 1).padStart(2, '0'),
      kind: 'skipped' as const,
    }))
    const r = daily10(all)
    expect(occurrencesBetween(r, '2026-01-01', '2026-12-31', 500)).toHaveLength(10)
    expect(pendingOccurrenceDates(r, '2026-01-01', '2026-12-31', 500)).toEqual([])
  })

  it('leaves the generated date set untouched for skipped and completed', () => {
    const plain = dates(daily10([]), '2026-01-01', '2026-12-31')
    const annotated = dates(
      daily10([
        { date: '2026-01-02', kind: 'skipped' },
        { date: '2026-01-04', kind: 'completed', completedAt: '2026-01-04T09:00:00.000Z' },
      ]),
      '2026-01-01',
      '2026-12-31',
    )
    expect(annotated).toEqual(plain)
  })

  it('marks completed occurrences and carries completedAt', () => {
    const out = occurrencesBetween(
      daily10([{ date: '2026-01-04', kind: 'completed', completedAt: '2026-01-04T09:00:00.000Z' }]),
      '2026-01-01',
      '2026-01-31',
      500,
    )
    expect(out.find((o) => o.date === '2026-01-04')).toEqual({
      date: '2026-01-04',
      seq: 3,
      status: 'completed',
      completedAt: '2026-01-04T09:00:00.000Z',
    })
  })

  it('relocates a moved occurrence, keeping its seq and the series length', () => {
    const out = occurrencesBetween(
      daily10([{ date: '2026-01-04', kind: 'moved', movedTo: '2026-01-06' }]),
      '2026-01-01',
      '2026-01-31',
      500,
    )
    expect(out).toHaveLength(10)
    expect(out.map((o) => o.date)).not.toContain('2026-01-04')
    expect(out.filter((o) => o.date === '2026-01-06')).toHaveLength(2)
    expect(out.find((o) => o.status === 'moved')).toEqual({
      date: '2026-01-06',
      seq: 3,
      status: 'moved',
      movedFrom: '2026-01-04',
      movedTo: '2026-01-06',
    })
    expect(out.at(-1)?.date).toBe('2026-01-10')
  })

  it('sorts a move that lands on an existing occurrence by seq', () => {
    const out = occurrencesBetween(
      daily10([{ date: '2026-01-08', kind: 'moved', movedTo: '2026-01-03' }]),
      '2026-01-01',
      '2026-01-31',
      500,
    )
    expect(out.filter((o) => o.date === '2026-01-03').map((o) => o.seq)).toEqual([2, 7])
  })

  it('drops an occurrence moved out of the window', () => {
    const out = dates(
      daily10([{ date: '2026-01-03', kind: 'moved', movedTo: '2026-02-15' }]),
      '2026-01-01',
      '2026-01-31',
    )
    expect(out).not.toContain('2026-01-03')
    expect(out).toHaveLength(9)
  })

  it('includes an occurrence moved into the window from outside it', () => {
    const out = occurrencesBetween(
      daily10([{ date: '2026-01-02', kind: 'moved', movedTo: '2026-03-15' }]),
      '2026-03-01',
      '2026-03-31',
      500,
    )
    expect(out).toEqual([
      {
        date: '2026-03-15',
        seq: 1,
        status: 'moved',
        movedFrom: '2026-01-02',
        movedTo: '2026-03-15',
      },
    ])
  })

  it('ignores an exception for a date that is not an occurrence', () => {
    const withStale = daily10([{ date: '2026-06-30', kind: 'skipped' }])
    expect(dates(withStale, '2026-01-01', '2026-12-31')).toEqual(
      dates(daily10([]), '2026-01-01', '2026-12-31'),
    )
  })

  it('never mutates the rule', () => {
    const r = daily10([
      { date: '2026-01-02', kind: 'skipped' },
      { date: '2026-01-04', kind: 'moved', movedTo: '2026-01-20' },
    ])
    const snapshot = structuredClone(r)
    occurrencesBetween(r, '2026-01-01', '2026-12-31', 500)
    expect(r).toEqual(snapshot)
  })
})

describe('consistency', () => {
  const r = rule({
    freq: 'weekly',
    starts: '2026-01-06',
    interval: 2,
    byWeekday: [2, 4],
    weekStart: 1,
    exceptions: [
      { date: '2026-01-08', kind: 'skipped' },
      { date: '2026-01-20', kind: 'completed', completedAt: '2026-01-20T08:00:00.000Z' },
      { date: '2026-02-03', kind: 'moved', movedTo: '2026-02-06' },
    ],
  })

  it('occurrenceDatesBetween is exactly the mapped dates of occurrencesBetween', () => {
    const records = occurrencesBetween(r, '2026-01-01', '2026-03-31', 500)
    expect(occurrenceDatesBetween(r, '2026-01-01', '2026-03-31', 500)).toEqual(
      records.map((o) => o.date),
    )
  })

  it('is deterministic across repeated calls', () => {
    expect(occurrencesBetween(r, '2026-01-01', '2026-03-31', 500)).toEqual(
      occurrencesBetween(r, '2026-01-01', '2026-03-31', 500),
    )
  })

  it('agrees whether generated in one window or month by month', () => {
    const whole = dates(r, '2026-01-01', '2026-03-31')
    const monthly = [
      ...dates(r, '2026-01-01', '2026-01-31'),
      ...dates(r, '2026-02-01', '2026-02-28'),
      ...dates(r, '2026-03-01', '2026-03-31'),
    ]
    expect(monthly).toEqual(whole)
  })
})
