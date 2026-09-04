import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  daysInMonth,
  epochDay,
  fromEpochDay,
  isISODate,
  isLeapYear,
  maxDate,
  minDate,
  startOfWeek,
  toISODate,
  weekday,
} from './dates.ts'

describe('toISODate', () => {
  it('reads local calendar parts, not UTC', () => {
    // 23:30 local on New Year's Eve is still 31 December, whatever the offset.
    expect(toISODate(new Date(2025, 11, 31, 23, 30))).toBe('2025-12-31')
    expect(toISODate(new Date(2026, 0, 1, 0, 15))).toBe('2026-01-01')
  })

  it('zero-pads single-digit months and days', () => {
    expect(toISODate(new Date(2026, 8, 4))).toBe('2026-09-04')
  })
})

describe('isISODate', () => {
  it('rejects malformed and impossible dates', () => {
    expect(isISODate('2026-13-01')).toBe(false)
    expect(isISODate('2026-02-30')).toBe(false)
    expect(isISODate('20260101')).toBe(false)
    expect(isISODate('2026-1-1')).toBe(false)
    expect(isISODate('2026-00-10')).toBe(false)
    expect(isISODate('')).toBe(false)
    expect(isISODate(20260101)).toBe(false)
  })

  it('accepts real dates including leap days', () => {
    expect(isISODate('2026-09-04')).toBe(true)
    expect(isISODate('2024-02-29')).toBe(true)
    expect(isISODate('2026-02-28')).toBe(true)
  })
})

describe('epochDay', () => {
  it('round-trips', () => {
    for (const iso of ['1970-01-01', '2000-02-29', '2100-03-01', '1899-12-31', '2026-09-04']) {
      expect(fromEpochDay(epochDay(iso))).toBe(iso)
    }
  })

  it('anchors at the epoch', () => {
    expect(epochDay('1970-01-01')).toBe(0)
    expect(epochDay('1969-12-31')).toBe(-1)
  })
})

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('goes backwards', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-09-04', 0)).toBe('2026-09-04')
  })
})

describe('daysBetween', () => {
  it('is signed and antisymmetric', () => {
    expect(daysBetween('2026-09-01', '2026-09-04')).toBe(3)
    expect(daysBetween('2026-09-04', '2026-09-01')).toBe(-3)
    expect(daysBetween('2026-09-04', '2026-09-04')).toBe(0)
  })

  it('counts the leap day', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366)
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365)
  })
})

describe('isLeapYear', () => {
  it('applies the century rules', () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2026)).toBe(false)
    expect(isLeapYear(2100)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
  })
})

describe('daysInMonth', () => {
  it('covers every month and both Februaries', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ])
    expect(daysInMonth(2024, 2)).toBe(29)
  })
})

describe('addMonths', () => {
  it('clamps the day to the target month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30')
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15')
  })

  it('is non-sticky when applied from the original anchor', () => {
    // The drift bug: Jan 31 -> Feb 28 -> Mar 28. From the anchor it stays 31.
    const anchor = '2026-01-31'
    expect(addMonths(anchor, 2)).toBe('2026-03-31')
    expect(addMonths(addMonths(anchor, 1), 1)).toBe('2026-03-28')
  })

  it('crosses year boundaries in both directions', () => {
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28')
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-31')
  })
})

describe('weekday', () => {
  it('matches known dates', () => {
    expect(weekday('1970-01-01')).toBe(4) // Thursday
    expect(weekday('2026-09-04')).toBe(5) // Friday
    expect(weekday('2026-09-06')).toBe(0) // Sunday
    expect(weekday('2024-02-29')).toBe(4) // Thursday
  })
})

describe('startOfWeek', () => {
  it('honours both conventions across a month edge', () => {
    // 2026-03-01 is a Sunday.
    expect(weekday('2026-03-01')).toBe(0)
    expect(startOfWeek('2026-03-01', 0)).toBe('2026-03-01')
    expect(startOfWeek('2026-03-01', 1)).toBe('2026-02-23')
    expect(startOfWeek('2026-09-04', 1)).toBe('2026-08-31')
    expect(startOfWeek('2026-09-04', 0)).toBe('2026-08-30')
  })

  it('is idempotent', () => {
    const w = startOfWeek('2026-09-04', 1)
    expect(startOfWeek(w, 1)).toBe(w)
  })
})

describe('ISO strings as a sort key', () => {
  it('sorts chronologically under the default comparator', () => {
    const dates = ['2026-10-02', '2026-01-31', '2025-12-31', '2026-02-01', '2026-01-05']
    expect([...dates].sort()).toEqual([
      '2025-12-31',
      '2026-01-05',
      '2026-01-31',
      '2026-02-01',
      '2026-10-02',
    ])
  })
})

describe('compareDates, minDate, maxDate', () => {
  it('orders and selects', () => {
    expect(compareDates('2026-01-01', '2026-01-02')).toBe(-1)
    expect(compareDates('2026-01-02', '2026-01-01')).toBe(1)
    expect(compareDates('2026-01-01', '2026-01-01')).toBe(0)
    expect(minDate('2026-01-02', '2026-01-01')).toBe('2026-01-01')
    expect(maxDate('2026-01-02', '2026-01-01')).toBe('2026-01-02')
  })
})
