import { describe, expect, it } from 'vitest'
import {
  completeOccurrence,
  currentOccurrence,
  describeRule,
  finalOccurrenceDate,
  moveOccurrence,
  nextOutstanding,
  occurrenceOn,
  previewOccurrences,
  ruleFields,
  seriesProgress,
  skipOccurrence,
  splitSeries,
  totalOccurrences,
} from './series.ts'
import { occurrenceDatesBetween } from './recurrence.ts'
import type { Recurrence } from './types.ts'

const rule = (over: Partial<Recurrence> & Pick<Recurrence, 'freq' | 'starts'>): Recurrence => ({
  id: 'r1',
  interval: 1,
  weekStart: 1,
  ends: { type: 'never' },
  exceptions: [],
  ...over,
})

/** 2026-01-05 is a Monday; every weekday date below is anchored off it. */
const MONDAY = '2026-01-05'

describe('finding the current occurrence', () => {
  it('sits on the date the task is due when that is an occurrence', () => {
    const r = rule({ freq: 'weekly', starts: MONDAY, byWeekday: [1] })
    expect(currentOccurrence(r, '2026-01-19', MONDAY)?.date).toBe('2026-01-19')
    expect(currentOccurrence(r, '2026-01-19', MONDAY)?.seq).toBe(2)
  })

  it('falls forward when the due date has been edited off the series', () => {
    const r = rule({ freq: 'weekly', starts: MONDAY, byWeekday: [1] })
    // Wednesday is not a Monday; the task is still on the coming Monday.
    expect(currentOccurrence(r, '2026-01-07', MONDAY)?.date).toBe('2026-01-12')
  })

  it('steps over occurrences that are already completed or skipped', () => {
    const r = rule({
      freq: 'daily',
      starts: MONDAY,
      exceptions: [
        { date: '2026-01-05', kind: 'completed', completedAt: '2026-01-05T09:00:00.000Z' },
        { date: '2026-01-06', kind: 'skipped' },
      ],
    })
    expect(nextOutstanding(r, MONDAY)?.date).toBe('2026-01-07')
  })

  it('reports nothing once the series has run out', () => {
    const r = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 2 } })
    expect(nextOutstanding(r, '2026-01-07')).toBeNull()
  })

  it('steps over a long completed run rather than giving up on the first batch', () => {
    const exceptions = occurrenceDatesBetween(
      rule({ freq: 'daily', starts: MONDAY }),
      MONDAY,
      '2026-04-05',
      200,
    ).map((date) => ({ date, kind: 'completed' as const }))

    const r = rule({ freq: 'daily', starts: MONDAY, exceptions })
    expect(nextOutstanding(r, MONDAY)?.date).toBe('2026-04-06')
  })
})

describe('one occurrence at a time', () => {
  const weekly = rule({ freq: 'weekly', starts: MONDAY, byWeekday: [1] })

  it('completing records an exception and never touches the rule', () => {
    const occurrence = occurrenceOn(weekly, MONDAY)!
    const after = completeOccurrence(weekly, occurrence, '2026-01-05T09:00:00.000Z')

    expect(after.exceptions).toEqual([
      { date: MONDAY, kind: 'completed', completedAt: '2026-01-05T09:00:00.000Z' },
    ])
    // Same dates, same length: exceptions annotate the series, never redefine it.
    expect(occurrenceDatesBetween(after, MONDAY, '2026-02-02')).toEqual(
      occurrenceDatesBetween(weekly, MONDAY, '2026-02-02'),
    )
    expect(weekly.exceptions).toEqual([])
  })

  it('completing advances the task to the next occurrence', () => {
    const after = completeOccurrence(weekly, occurrenceOn(weekly, MONDAY)!, '2026-01-05T09:00:00.000Z')
    expect(nextOutstanding(after, MONDAY)?.date).toBe('2026-01-12')
  })

  it('a skip consumes one of an ends.after count', () => {
    const capped = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 3 } })
    const skipped = skipOccurrence(capped, occurrenceOn(capped, MONDAY)!)

    // Three dates still, one of them merely skipped — the count is spent.
    expect(occurrenceDatesBetween(skipped, MONDAY, '2026-02-01')).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
    ])
    expect(nextOutstanding(skipped, MONDAY)?.date).toBe('2026-01-06')
  })

  it('keys an exception to the generated date, not the moved-to date', () => {
    const moved = moveOccurrence(weekly, occurrenceOn(weekly, MONDAY)!, '2026-01-07')
    expect(moved.exceptions).toEqual([{ date: MONDAY, kind: 'moved', movedTo: '2026-01-07' }])

    const occurrence = occurrenceOn(moved, '2026-01-07')!
    expect(occurrence.movedFrom).toBe(MONDAY)
    // Completing the moved occurrence must land on the date the generator knows.
    const done = completeOccurrence(moved, occurrence, '2026-01-07T09:00:00.000Z')
    expect(done.exceptions.map((e) => e.date)).toEqual([MONDAY])
    expect(done.exceptions[0]!.kind).toBe('completed')
  })

  it('moving an occurrence back to its own date drops the exception', () => {
    const moved = moveOccurrence(weekly, occurrenceOn(weekly, MONDAY)!, '2026-01-07')
    const back = moveOccurrence(moved, occurrenceOn(moved, '2026-01-07')!, MONDAY)
    expect(back.exceptions).toEqual([])
  })
})

describe('how long the series is', () => {
  it('is unknowable for an endless rule', () => {
    expect(totalOccurrences(rule({ freq: 'daily', starts: MONDAY }))).toBeNull()
  })

  it('is the stated count for an ends.after rule', () => {
    const r = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 10 } })
    expect(totalOccurrences(r)).toBe(10)
    expect(finalOccurrenceDate(r)).toBe('2026-01-14')
  })

  it('counts an until rule, skipped occurrences included', () => {
    const r = rule({
      freq: 'weekly',
      starts: MONDAY,
      byWeekday: [1],
      ends: { type: 'until', date: '2026-02-02' },
      exceptions: [{ date: '2026-01-12', kind: 'skipped' }],
    })
    expect(totalOccurrences(r)).toBe(5)
    expect(finalOccurrenceDate(r)).toBe('2026-02-02')
  })

  it('declines to count a series longer than it will generate', () => {
    const r = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 50_000 } })
    expect(totalOccurrences(r)).toBeNull()
    expect(finalOccurrenceDate(r)).toBeNull()
  })

  it('reports a position out of a total, not a remainder', () => {
    const r = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 10 } })
    expect(seriesProgress(r, occurrenceOn(r, '2026-01-07'))).toEqual({ index: 3, total: 10 })
  })

  it('has no position to report when the rule never ends', () => {
    const r = rule({ freq: 'daily', starts: MONDAY })
    expect(seriesProgress(r, occurrenceOn(r, MONDAY))).toBeNull()
  })
})

describe('previewing', () => {
  it('shows the next five and no more, even for a rule that never ends', () => {
    const r = rule({ freq: 'weekly', starts: MONDAY, byWeekday: [1, 4] })
    expect(previewOccurrences(r, MONDAY, 5).map((o) => o.date)).toEqual([
      '2026-01-05',
      '2026-01-08',
      '2026-01-12',
      '2026-01-15',
      '2026-01-19',
    ])
  })

  it('omits what has already been dealt with', () => {
    const r = rule({
      freq: 'daily',
      starts: MONDAY,
      exceptions: [{ date: '2026-01-06', kind: 'skipped' }],
    })
    expect(previewOccurrences(r, MONDAY, 3).map((o) => o.date)).toEqual([
      '2026-01-05',
      '2026-01-07',
      '2026-01-08',
    ])
  })

  it('runs out gracefully at the end of a finite series', () => {
    const r = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 2 } })
    expect(previewOccurrences(r, MONDAY, 5)).toHaveLength(2)
  })
})

describe('saying it in words', () => {
  it('names the repeating part and the ending in one sentence', () => {
    const r = rule({
      freq: 'weekly',
      interval: 2,
      starts: MONDAY,
      byWeekday: [2, 4],
      ends: { type: 'until', date: '2026-12-15' },
    })
    expect(describeRule(r)).toBe(
      'Every other week on Tuesday and Thursday, until 15 December 2026',
    )
  })

  it('gives a counted rule its count and the date it lands on', () => {
    const r = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 10 } })
    expect(describeRule(r)).toBe('Every day, 10 times (ending 14 January 2026)')
  })

  it('says nothing about an ending when there is not one', () => {
    expect(describeRule(rule({ freq: 'monthly', starts: MONDAY, byMonthDay: 5 }))).toBe(
      'Every month on day 5',
    )
  })
})

describe('splitting a series', () => {
  const weekly = rule({
    freq: 'weekly',
    starts: MONDAY,
    byWeekday: [1],
    exceptions: [
      { date: '2026-01-05', kind: 'completed', completedAt: '2026-01-05T09:00:00.000Z' },
      { date: '2026-01-12', kind: 'completed', completedAt: '2026-01-12T09:00:00.000Z' },
    ],
  })

  it('ends the original the day before and starts the new one on the day', () => {
    const { previous, next } = splitSeries(weekly, '2026-01-19')
    expect(previous?.ends).toEqual({ type: 'until', date: '2026-01-18' })
    expect(next.starts).toBe('2026-01-19')
  })

  it('leaves the completed half where it happened', () => {
    const { previous } = splitSeries(weekly, '2026-01-19')
    expect(previous?.exceptions.map((e) => e.date)).toEqual(['2026-01-05', '2026-01-12'])
    expect(occurrenceDatesBetween(previous!, MONDAY, '2026-03-01')).toEqual([
      '2026-01-05',
      '2026-01-12',
    ])
  })

  it('drops the original when nothing happened in it worth recording', () => {
    const clean = rule({ freq: 'weekly', starts: MONDAY, byWeekday: [1] })
    expect(splitSeries(clean, '2026-01-19').previous).toBeNull()
  })

  it('drops the original when the split covers the whole series', () => {
    expect(splitSeries(weekly, MONDAY).previous).toBeNull()
  })

  it('carries the unused half of an ends.after count into the new rule', () => {
    const counted = rule({
      freq: 'daily',
      starts: MONDAY,
      ends: { type: 'after', count: 10 },
      exceptions: [{ date: MONDAY, kind: 'completed' }],
    })
    // Three occurrences on 5, 6 and 7 January have been used up by the 8th.
    expect(splitSeries(counted, '2026-01-08').next.ends).toEqual({ type: 'after', count: 7 })
  })

  it('takes an explicit end condition at face value: the user just set it', () => {
    const counted = rule({ freq: 'daily', starts: MONDAY, ends: { type: 'after', count: 10 } })
    const { next } = splitSeries(counted, '2026-01-08', { ends: { type: 'after', count: 3 } })
    expect(next.ends).toEqual({ type: 'after', count: 3 })
  })

  it('carries only the fields the new frequency uses', () => {
    const { next } = splitSeries(weekly, '2026-01-19', { freq: 'monthly', byMonthDay: 19 })
    expect(next.byWeekday).toBeUndefined()
    expect(next.byMonthDay).toBe(19)
  })

  it('drops a by-month-day when the new rule is by nth weekday instead', () => {
    const monthly = rule({ freq: 'monthly', starts: MONDAY, byMonthDay: 5 })
    const { next } = splitSeries(monthly, '2026-03-05', {
      byNthWeekday: { nth: -1, weekday: 5 },
    })
    expect(next.byMonthDay).toBeUndefined()
    expect(next.byNthWeekday).toEqual({ nth: -1, weekday: 5 })
  })

  it('keeps the two halves from producing the same date twice', () => {
    const { previous, next } = splitSeries(weekly, '2026-01-19')
    const before = occurrenceDatesBetween(previous!, MONDAY, '2026-03-01')
    const after = occurrenceDatesBetween({ ...weekly, ...next, exceptions: [] }, MONDAY, '2026-03-01')
    expect(before.filter((d) => after.includes(d))).toEqual([])
  })
})

describe('ruleFields', () => {
  it('drops identity and history, keeping only what an editor edits', () => {
    const fields = ruleFields(weeklyWithHistory())
    expect(fields).not.toHaveProperty('id')
    expect(fields).not.toHaveProperty('exceptions')
    expect(fields.byWeekday).toEqual([1])
  })

  function weeklyWithHistory(): Recurrence {
    return rule({
      freq: 'weekly',
      starts: MONDAY,
      byWeekday: [1],
      exceptions: [{ date: MONDAY, kind: 'skipped' }],
    })
  }
})
