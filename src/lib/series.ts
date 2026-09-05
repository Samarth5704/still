/**
 * Living with a recurrence rule.
 *
 * `recurrence.ts` answers "what dates does this rule produce". This module
 * answers the questions the *app* asks of a series: which occurrence is the
 * task sitting on right now, what happens when you tick it, what happens when
 * you skip it, how far through the series you are, and — the hard one — what
 * "this and all future" does to the rule.
 *
 * Pure, like everything in `lib/`: no clock, no DOM, no ids. Minting the id for
 * a new rule is the store's job, so every function here that produces a new
 * rule either reuses the one it was given or returns bare `RuleFields`.
 *
 * ### The series is the task
 *
 * There is one `Task` per recurring series, not one per occurrence, and its
 * `due` is the occurrence it is currently sitting on. That is the whole model,
 * and everything below follows from it:
 *
 * - Completing an occurrence records a `'completed'` exception and moves the
 *   task's `due` to the next one. The rule is never touched.
 * - Skipping does the same with a `'skipped'` exception, which still consumes
 *   one of an `ends.after` count — so the UI has to show the count, or a skip
 *   silently steals an occurrence the user was expecting.
 * - Exhausting the series is the only thing that completes the task itself.
 */
import { addDays, addYears, compareDates, formatLongDate } from './dates.ts'
import { describeRecurrence } from './parse.ts'
import { occurrencesBetween } from './recurrence.ts'
import type {
  ISODate,
  Occurrence,
  Recurrence,
  RecurrenceEnd,
  RecurrenceException,
  WeekStart,
} from './types.ts'

/**
 * How far ahead the "what comes next" searches will look.
 *
 * Every one of them is still a bounded window over a bounded generator, per the
 * Phase 1 rule — this is the window. A century is unreachable for any rule a
 * person would write down and costs nothing to ask for: the walker
 * fast-forwards to the window and stops at the first match.
 */
const HORIZON_YEARS = 100

/**
 * The largest series this module will count all the way through.
 *
 * "3 of 10 scheduled" is worth computing; "3 of 40,000 scheduled" is not
 * information, and generating it to find that out would be the unbounded
 * traversal Phase 1 forbids. Past this, the count reads as unknown and the UI
 * shows the rule without a position.
 */
const MAX_COUNTED = 1000

/** A rule with no identity and no history: what an editor produces. */
export type RuleFields = Omit<Recurrence, 'id' | 'exceptions'>

export type SeriesOptions = { weekStart?: WeekStart }

/** An occurrence that has neither been done nor waved away: still to happen. */
function isOutstanding(o: Occurrence): boolean {
  return o.status === 'pending' || o.status === 'moved'
}

function horizonFrom(date: ISODate): ISODate {
  return addYears(date, HORIZON_YEARS)
}

/** The occurrence landing exactly on `date`, whatever its status. */
export function occurrenceOn(
  rule: Recurrence,
  date: ISODate,
  opts?: SeriesOptions,
): Occurrence | null {
  return occurrencesBetween(rule, date, date, 8, opts)[0] ?? null
}

/**
 * The first occurrence still to happen at or after `from`, or null when the
 * series has run out.
 *
 * Completed and skipped occurrences are passed over: both have been dealt
 * with, and the task has no further business sitting on them.
 */
export function nextOutstanding(
  rule: Recurrence,
  from: ISODate,
  opts?: SeriesOptions,
): Occurrence | null {
  // A skipped or completed run at the head of the window has to be stepped
  // over, so ask for a handful rather than one, and widen only if they are all
  // spoken for.
  let cursor = from
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const batch = occurrencesBetween(rule, cursor, horizonFrom(cursor), 32, opts)
    const found = batch.find(isOutstanding)
    if (found) return found
    const last = batch[batch.length - 1]
    if (batch.length < 32 || last === undefined) return null
    cursor = addDays(last.date, 1)
  }
  return null
}

/**
 * The occurrence a task sitting on `due` is currently on.
 *
 * `due` is normally an occurrence date exactly, but a due date edited by hand
 * can land between two of them — so this falls forward to the next outstanding
 * occurrence rather than reporting that the task is on nothing at all.
 */
export function currentOccurrence(
  rule: Recurrence,
  due: ISODate | null,
  today: ISODate,
  opts?: SeriesOptions,
): Occurrence | null {
  const from = due ?? today
  const exact = occurrenceOn(rule, from, opts)
  if (exact && isOutstanding(exact)) return exact
  return nextOutstanding(rule, from, opts)
}

/** The next `count` occurrences still to happen, for the editor's preview. */
export function previewOccurrences(
  rule: Recurrence,
  from: ISODate,
  count: number,
  opts?: SeriesOptions,
): Occurrence[] {
  if (count <= 0) return []
  const found: Occurrence[] = []
  let cursor = from
  for (let attempt = 0; attempt < 8 && found.length < count; attempt += 1) {
    const batch = occurrencesBetween(rule, cursor, horizonFrom(cursor), count * 4, opts)
    for (const occurrence of batch) {
      if (isOutstanding(occurrence)) found.push(occurrence)
      if (found.length === count) return found
    }
    const last = batch[batch.length - 1]
    if (batch.length < count * 4 || last === undefined) break
    cursor = addDays(last.date, 1)
  }
  return found
}

// ---- how long the series is ------------------------------------------------

/**
 * How many occurrences the whole series has, or null when that is unknowable —
 * an endless rule, or one longer than this module will count.
 *
 * Skipped occurrences are included, because they are part of the series the
 * user described and they still consume an `ends.after` count.
 */
export function totalOccurrences(rule: Recurrence, opts?: SeriesOptions): number | null {
  if (rule.ends.type === 'never') return null
  if (rule.ends.type === 'after') {
    return rule.ends.count <= MAX_COUNTED ? rule.ends.count : null
  }
  if (compareDates(rule.ends.date, rule.starts) < 0) return 0
  const all = occurrencesBetween(rule, rule.starts, rule.ends.date, MAX_COUNTED + 1, opts)
  return all.length > MAX_COUNTED ? null : all.length
}

/** The last date the rule produces, or null when it never ends or is too long to count. */
export function finalOccurrenceDate(rule: Recurrence, opts?: SeriesOptions): ISODate | null {
  const total = totalOccurrences(rule, opts)
  if (total === null || total === 0) return null
  const end = rule.ends.type === 'until' ? rule.ends.date : horizonFrom(rule.starts)
  const all = occurrencesBetween(rule, rule.starts, end, total, opts)
  return all[all.length - 1]?.date ?? null
}

export type SeriesProgress = {
  /** 1-based position of this occurrence within the series. */
  index: number
  total: number
}

/**
 * "3 of 10 scheduled", as two numbers.
 *
 * Deliberately a position and not a remainder. A skipped occurrence still burns
 * one of an `ends.after` count, so a bare "3 left" would quietly disagree with
 * itself the first time somebody skipped one; a position out of a stated total
 * cannot.
 */
export function seriesProgress(
  rule: Recurrence,
  occurrence: Occurrence | null,
  opts?: SeriesOptions,
): SeriesProgress | null {
  if (!occurrence) return null
  const total = totalOccurrences(rule, opts)
  if (total === null) return null
  return { index: occurrence.seq + 1, total }
}

// ---- saying it in words ----------------------------------------------------

function describeEnd(rule: Recurrence, opts?: SeriesOptions): string {
  if (rule.ends.type === 'never') return ''
  if (rule.ends.type === 'until') return `, until ${formatLongDate(rule.ends.date)}`

  // "10 times" is the count the user typed; the final date is the thing they
  // actually want to know and cannot work out in their head.
  const last = finalOccurrenceDate(rule, opts)
  const times = `, ${rule.ends.count} ${rule.ends.count === 1 ? 'time' : 'times'}`
  return last === null ? times : `${times} (ending ${formatLongDate(last)})`
}

/**
 * The whole rule in one sentence: "Every 2 weeks on Tuesday and Thursday, until
 * 15 December 2026".
 *
 * `describeRecurrence` in `parse.ts` says the repeating part and is shared with
 * the quick-add preview, so the phrase a user sees while typing and the phrase
 * they see in the editor are the same words. This adds the end condition, which
 * quick add cannot express.
 */
export function describeRule(rule: Recurrence, opts?: SeriesOptions): string {
  const draft = { ...rule, weekStart: rule.weekStart ?? opts?.weekStart ?? 1 }
  return `${describeRecurrence(draft)}${describeEnd(rule, opts)}`
}

// ---- changing one occurrence -----------------------------------------------

/**
 * Record an exception against `occurrence`, replacing any exception already
 * standing at the same date.
 *
 * The key is always the *generated* date — `movedFrom` for an occurrence that
 * has been moved — because that is the date the generator will produce next
 * time and therefore the only date an exception can be matched against.
 */
function withException(
  rule: Recurrence,
  occurrence: Occurrence,
  exception: Omit<RecurrenceException, 'date'>,
): Recurrence {
  const date = occurrence.movedFrom ?? occurrence.date
  return {
    ...rule,
    exceptions: [...rule.exceptions.filter((e) => e.date !== date), { date, ...exception }],
  }
}

export function completeOccurrence(
  rule: Recurrence,
  occurrence: Occurrence,
  completedAt: string,
): Recurrence {
  return withException(rule, occurrence, { kind: 'completed', completedAt })
}

export function skipOccurrence(rule: Recurrence, occurrence: Occurrence): Recurrence {
  return withException(rule, occurrence, { kind: 'skipped' })
}

/**
 * Relocate one occurrence without touching the rule. Moving it back to the day
 * the rule generated drops the exception rather than recording a no-op move.
 */
export function moveOccurrence(
  rule: Recurrence,
  occurrence: Occurrence,
  to: ISODate,
): Recurrence {
  const from = occurrence.movedFrom ?? occurrence.date
  if (from === to) {
    return { ...rule, exceptions: rule.exceptions.filter((e) => e.date !== from) }
  }
  return withException(rule, occurrence, { kind: 'moved', movedTo: to })
}

// ---- splitting the rule in two ---------------------------------------------

export type Split = {
  /**
   * The original rule, ended the day before the split — or null when there is
   * nothing left in it worth keeping.
   *
   * A truncated rule with no exceptions is a husk: no task points at it, so
   * nothing can render it and nothing can complete it. It is dropped. One that
   * carries exceptions is the record of what was actually done in the first
   * half of the series, and it is kept for the calendar to read.
   */
  previous: Recurrence | null
  /** The rule from the split date onward. The store gives it an id. */
  next: RuleFields
}

/**
 * "This and all future": end the original the day before `at`, and start a new
 * rule from `at`.
 *
 * This is the part most implementations skip, and skipping it is why editing a
 * repeating task in most todo apps either rewrites your history or refuses.
 * Splitting keeps both halves true: everything before `at` happened the way it
 * happened, and everything from `at` onward follows the new rule.
 *
 * `fields` are the new rule's settings, defaulting to the original's. Leaving
 * `fields.ends` out means "the same ending, minus what has already been used":
 * a rule set to run ten times that has already produced three carries seven
 * into the new half, so the user's "ten" is not silently doubled. Passing an
 * explicit `ends` means the user changed it in the editor and meant it.
 */
export function splitSeries(
  rule: Recurrence,
  at: ISODate,
  fields: Partial<RuleFields> = {},
  opts?: SeriesOptions,
): Split {
  const dayBefore = addDays(at, -1)
  const startsLater = compareDates(at, rule.starts) > 0

  const consumed = startsLater
    ? occurrencesBetween(rule, rule.starts, dayBefore, MAX_COUNTED, opts).length
    : 0

  const kept = rule.exceptions.filter((e) => compareDates(e.date, at) < 0)
  const previous: Recurrence | null =
    startsLater && kept.length > 0
      ? { ...rule, ends: { type: 'until', date: dayBefore }, exceptions: kept }
      : null

  const ends: RecurrenceEnd = fields.ends ?? carryEnd(rule.ends, consumed)

  const next: RuleFields = {
    freq: fields.freq ?? rule.freq,
    interval: fields.interval ?? rule.interval,
    starts: at,
    weekStart: fields.weekStart ?? rule.weekStart,
    ends,
  }
  // Only the fields the new frequency actually uses come across: carrying a
  // stale `byWeekday` onto a monthly rule would leave a field the generator
  // ignores today and might not ignore later.
  const source = { ...rule, ...fields }
  if (next.freq === 'weekly' && source.byWeekday) next.byWeekday = [...source.byWeekday]
  if (next.freq === 'monthly' || next.freq === 'yearly') {
    if (source.byMonthDay !== undefined) next.byMonthDay = source.byMonthDay
  }
  if (next.freq === 'monthly' && source.byNthWeekday) {
    next.byNthWeekday = { ...source.byNthWeekday }
    delete next.byMonthDay
  }
  if (next.freq === 'yearly' && source.byMonth !== undefined) next.byMonth = source.byMonth

  return { previous, next }
}

/** An `after` count minus what the first half already used, never below one. */
function carryEnd(ends: RecurrenceEnd, consumed: number): RecurrenceEnd {
  if (ends.type !== 'after') return ends
  return { type: 'after', count: Math.max(1, ends.count - consumed) }
}

/** Strip a rule down to the settings an editor round-trips, dropping id and history. */
export function ruleFields(rule: Recurrence): RuleFields {
  const { id: _id, exceptions: _exceptions, ...fields } = rule
  return fields
}
