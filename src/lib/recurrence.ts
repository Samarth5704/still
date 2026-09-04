/**
 * Lazy occurrence generation for recurrence rules.
 *
 * A rule is never materialised. Every function here takes an explicit window
 * and a hard cap, and a rule with `ends: { type: 'never' }` can only ever
 * produce as many records as the window and the cap allow.
 *
 * There is exactly one traversal, `walk`, which yields occurrences in series
 * order and assigns `seq` as it goes. `ends.after` is therefore correct by
 * construction: there is no second "how many came before the window" code path
 * that could disagree with the generation path.
 */
import {
  addDays,
  compareDates,
  daysInMonth,
  epochDay,
  formatISODate,
  fromEpochDay,
  isISODate,
  maxDate,
  minDate,
  parseISODate,
  startOfWeek,
  weekday,
} from './dates.ts'
import type { ISODate, Occurrence, Recurrence, WeekStart } from './types.ts'

/**
 * Ceiling on how many *periods* the walker will step. Periods are days for a
 * daily rule and months or years otherwise, so this is unreachable for any
 * rule a person could create; it exists so that a mis-specified termination
 * condition degrades into a short array rather than a hung tab.
 */
const MAX_PERIODS = 200_000

export const DEFAULT_CAP = 512

export type OccurrenceOptions = {
  /** Overridden by `rule.weekStart` when the rule carries one. Defaults to Monday. */
  weekStart?: WeekStart
}

type Raw = { date: ISODate; seq: number }

function resolveWeekStart(rule: Recurrence, opts?: OccurrenceOptions): WeekStart {
  return rule.weekStart ?? opts?.weekStart ?? 1
}

function normaliseWeekdays(rule: Recurrence): number[] {
  const raw = rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday : [weekday(rule.starts)]
  return [...new Set(raw)].sort((a, b) => a - b)
}

/** The nth (1-based, or -1 for last) `weekday` of a month, or null if absent. */
function nthWeekdayOfMonth(y: number, m: number, nth: number, target: number): ISODate | null {
  const length = daysInMonth(y, m)
  if (nth === -1) {
    const last = formatISODate(y, m, length)
    return addDays(last, -(((weekday(last) - target) % 7 + 7) % 7))
  }
  if (nth < 1) return null
  const first = formatISODate(y, m, 1)
  const day = 1 + (((target - weekday(first)) % 7 + 7) % 7) + (nth - 1) * 7
  return day > length ? null : formatISODate(y, m, day)
}

/**
 * Walk the series from `starts` forward, in order, yielding `seq` as assigned.
 *
 * `from` is a performance hint only: the walker fast-forwards to it but the
 * seq numbering is unaffected, so a window opening mid-series still reports
 * true positions within the series.
 */
function* walk(rule: Recurrence, weekStart: WeekStart, from: ISODate): Generator<Raw> {
  const { interval, starts } = rule
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError(`recurrence interval must be a positive integer, got ${interval}`)
  }
  if (!isISODate(starts)) throw new RangeError(`recurrence starts is not a date: ${starts}`)

  const limit = rule.ends.type === 'after' ? rule.ends.count : Infinity
  const until = rule.ends.type === 'until' ? rule.ends.date : null
  if (limit <= 0) return

  // Never fast-forward past the start of the series.
  const skipTo = compareDates(from, starts) > 0 ? from : starts

  if (rule.freq === 'daily') {
    const startEpoch = epochDay(starts)
    const first = Math.max(0, Math.ceil((epochDay(skipTo) - startEpoch) / interval))
    for (let k = first; k - first < MAX_PERIODS; k += 1) {
      if (k >= limit) return
      const date = fromEpochDay(startEpoch + k * interval)
      if (until && compareDates(date, until) > 0) return
      yield { date, seq: k }
    }
    return
  }

  if (rule.freq === 'weekly') {
    const days = normaliseWeekdays(rule)
    const anchor = epochDay(startOfWeek(starts, weekStart))
    const offsets = days.map((d) => ((d - weekStart) % 7 + 7) % 7).sort((a, b) => a - b)
    const span = interval * 7
    // The anchor week may open before `starts`; those weekdays are not
    // occurrences and must not consume a seq.
    const inFirstWeek = offsets.filter((o) => anchor + o >= epochDay(starts)).length

    const skipWeek = Math.max(
      0,
      Math.floor((epochDay(startOfWeek(skipTo, weekStart)) - anchor) / span),
    )
    for (let w = skipWeek; w - skipWeek < MAX_PERIODS; w += 1) {
      const weekEpoch = anchor + w * span
      let seq = w === 0 ? 0 : inFirstWeek + (w - 1) * days.length
      for (const offset of offsets) {
        const epoch = weekEpoch + offset
        if (epoch < epochDay(starts)) continue
        if (seq >= limit) return
        const date = fromEpochDay(epoch)
        if (until && compareDates(date, until) > 0) return
        yield { date, seq }
        seq += 1
      }
    }
    return
  }

  const { y: sy, m: sm, d: sd } = parseISODate(starts)

  if (rule.freq === 'monthly') {
    const base = sy * 12 + (sm - 1)
    let seq = 0
    for (let p = 0; p < MAX_PERIODS; p += 1) {
      const index = base + p * interval
      const y = Math.floor(index / 12)
      const m = index - y * 12 + 1
      let date: ISODate | null
      if (rule.byNthWeekday) {
        // Deliberately no clamping here: "the 5th Friday" names a specific rare
        // week, unlike "the 31st", which means the end of the month.
        date = nthWeekdayOfMonth(y, m, rule.byNthWeekday.nth, rule.byNthWeekday.weekday)
      } else {
        date = formatISODate(y, m, Math.min(rule.byMonthDay ?? sd, daysInMonth(y, m)))
      }
      if (date === null) continue
      if (compareDates(date, starts) < 0) continue
      if (seq >= limit) return
      if (until && compareDates(date, until) > 0) return
      yield { date, seq }
      seq += 1
    }
    return
  }

  const month = rule.byMonth ?? sm
  const day = rule.byMonthDay ?? sd
  let seq = 0
  for (let p = 0; p < MAX_PERIODS; p += 1) {
    const y = sy + p * interval
    // 29 February clamps to the 28th in common years, for the same reason the
    // 31st clamps: the task belongs in the month the user picked.
    const date = formatISODate(y, month, Math.min(day, daysInMonth(y, month)))
    if (compareDates(date, starts) >= 0) {
      if (seq >= limit) return
      if (until && compareDates(date, until) > 0) return
      yield { date, seq }
      seq += 1
    }
  }
}

/**
 * Occurrences of `rule` whose final date falls within `[windowStart, windowEnd]`,
 * in date order, at most `cap` of them.
 *
 * Exceptions filter and annotate the series; they never change its length or
 * its generated dates. A skipped occurrence is returned with
 * `status: 'skipped'` and still consumes one of `ends.after`'s count, and a
 * moved occurrence keeps its `seq`.
 */
export function occurrencesBetween(
  rule: Recurrence,
  windowStart: ISODate,
  windowEnd: ISODate,
  cap: number = DEFAULT_CAP,
  opts?: OccurrenceOptions,
): Occurrence[] {
  if (!isISODate(windowStart) || !isISODate(windowEnd)) {
    throw new RangeError(`window is not a pair of dates: ${windowStart}..${windowEnd}`)
  }
  if (compareDates(windowStart, windowEnd) > 0) {
    throw new RangeError(`window ends before it starts: ${windowStart}..${windowEnd}`)
  }
  if (!Number.isInteger(cap) || cap < 0) throw new RangeError(`cap must be a non-negative integer, got ${cap}`)

  const weekStart = resolveWeekStart(rule, opts)
  const byOriginalDate = new Map(rule.exceptions.map((e) => [e.date, e]))
  if (cap === 0) {
    // Still validate the rule, so a bad interval fails the same way at any cap.
    walk(rule, weekStart, windowStart).next()
    return []
  }

  // An occurrence moved into the window is generated outside it, so widen the
  // generation range to cover exactly those originals — no guessed padding.
  let genStart = windowStart
  let genEnd = windowEnd
  let movable = 0
  for (const e of rule.exceptions) {
    if (e.kind !== 'moved' || !e.movedTo) continue
    movable += 1
    if (compareDates(e.movedTo, windowStart) >= 0 && compareDates(e.movedTo, windowEnd) <= 0) {
      genStart = minDate(genStart, e.date)
      genEnd = maxDate(genEnd, e.date)
    }
  }

  const found: Occurrence[] = []
  // A move can pull a later occurrence earlier, so the first `cap` by date are
  // not necessarily the first `cap` generated — but only moved occurrences can
  // reorder, and there are at most `movable` of those.
  const budget = cap + movable
  for (const raw of walk(rule, weekStart, genStart)) {
    if (compareDates(raw.date, genEnd) > 0) break
    if (compareDates(raw.date, genStart) < 0) continue

    const exception = byOriginalDate.get(raw.date)
    let occurrence: Occurrence
    if (!exception) {
      occurrence = { date: raw.date, seq: raw.seq, status: 'pending' }
    } else if (exception.kind === 'skipped') {
      occurrence = { date: raw.date, seq: raw.seq, status: 'skipped' }
    } else if (exception.kind === 'completed') {
      occurrence = { date: raw.date, seq: raw.seq, status: 'completed' }
      if (exception.completedAt) occurrence.completedAt = exception.completedAt
    } else if (exception.movedTo) {
      occurrence = {
        date: exception.movedTo,
        seq: raw.seq,
        status: 'moved',
        movedFrom: raw.date,
        movedTo: exception.movedTo,
      }
    } else {
      // A 'moved' exception with no destination is malformed; leave it be.
      occurrence = { date: raw.date, seq: raw.seq, status: 'pending' }
    }

    if (compareDates(occurrence.date, windowStart) < 0) continue
    if (compareDates(occurrence.date, windowEnd) > 0) continue
    found.push(occurrence)
    if (found.length >= budget) break
  }

  found.sort((a, b) => compareDates(a.date, b.date) || a.seq - b.seq)
  return found.slice(0, cap)
}

/**
 * The dates of `occurrencesBetween`, as a thin map over the same traversal —
 * never a second walk, so the calendar and the list cannot disagree about what
 * exists. Includes skipped occurrences; filter on status, or use
 * `pendingOccurrenceDates`.
 */
export function occurrenceDatesBetween(
  rule: Recurrence,
  windowStart: ISODate,
  windowEnd: ISODate,
  cap: number = DEFAULT_CAP,
  opts?: OccurrenceOptions,
): ISODate[] {
  return occurrencesBetween(rule, windowStart, windowEnd, cap, opts).map((o) => o.date)
}

/** The dates a user would still expect to see: everything except skipped. */
export function pendingOccurrenceDates(
  rule: Recurrence,
  windowStart: ISODate,
  windowEnd: ISODate,
  cap: number = DEFAULT_CAP,
  opts?: OccurrenceOptions,
): ISODate[] {
  return occurrencesBetween(rule, windowStart, windowEnd, cap, opts)
    .filter((o) => o.status !== 'skipped')
    .map((o) => o.date)
}
