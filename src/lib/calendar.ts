/**
 * What sits on which day.
 *
 * Pure, like everything in `lib/`: `today` and the window arrive as arguments.
 * The month grid and the agenda are two shapes over one answer, and they read
 * it from the same function so they can never disagree about what a Tuesday
 * contains.
 *
 * ### Why this cannot just filter tasks by `due`
 *
 * The task *is* the series (see `series.ts`): one `Task` per rule, whose `due`
 * is the single occurrence it is currently sitting on. Next Tuesday's instance
 * of a weekly task is not a row in `state.tasks` and never will be. So a
 * calendar cannot find an occurrence by looking for a task on that date — it
 * has to pull occurrences out of `state.recurrences` for exactly the window on
 * screen and attribute each one to the task carrying that rule.
 *
 * Every generation call here therefore takes an explicit window and a hard cap,
 * per the Phase 1 rule. A rule that never ends produces at most one entry per
 * day of the window, because that is all a window can hold.
 */
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  endOfWeek,
  formatISODate,
  formatLongDate,
  parseISODate,
  startOfWeek,
  weekday,
} from './dates.ts'
import { occurrencesBetween } from './recurrence.ts'
import type {
  ISODate,
  OccurrenceStatus,
  Priority,
  Recurrence,
  State,
  Task,
  WeekStart,
} from './types.ts'

/**
 * The longest window this module will build. Six weeks is what a month grid
 * needs and a season is what the agenda asks for; anything past this is a
 * caller that has lost track of what it is drawing, and it should fail loudly
 * rather than walk every rule in the state for a year.
 */
export const MAX_WINDOW_DAYS = 400

/**
 * The hard ceiling on occurrences taken from any one rule, independent of the
 * window. The window's own length is the tighter bound in every real case —
 * a rule cannot put two occurrences on one day unless one was moved onto it —
 * and this is the backstop for a window that somehow got long.
 */
export const MAX_PER_RULE = 512

/**
 * Days fetched either side of the window actually drawn.
 *
 * Not padding against moved occurrences: `occurrencesBetween` widens its own
 * generation range to catch those exactly, with no guesswork. This is for the
 * *view* — the day panel can be showing a day just off the grid's edge, and the
 * agenda scrolls past its own last row — so one extra week either side means
 * those come out of the map already built rather than a second pass over every
 * rule in the state.
 */
export const WINDOW_MARGIN_DAYS = 7

export type EntryStatus = OccurrenceStatus

export type CalendarEntry = {
  /** Stable across renders, so the day's list reconciles rather than rebuilds. */
  key: string
  taskId: string
  title: string
  date: ISODate
  dueTime: string | null
  priority: Priority
  projectId: string | null
  /** True when this entry came out of a recurrence rule. */
  repeats: boolean
  status: EntryStatus
  /**
   * True when ticking this entry would tick the task: the open task itself, or
   * the one occurrence its `due` is sitting on. Everything else on the grid is
   * a record or a forecast, and offering a checkbox on it would be a lie about
   * what the click does.
   */
  actionable: boolean
  /** Pending, and the date has passed. */
  overdue: boolean
}

export type CalendarDay = {
  date: ISODate
  /** Day of the month, for the grid's numeral. */
  dayOfMonth: number
  /** False for the leading and trailing days a six-week grid borrows. */
  inMonth: boolean
  isToday: boolean
  isWeekend: boolean
  entries: CalendarEntry[]
  /** Outstanding entries only: what the day still asks of you. */
  pending: number
  /** Pending and already past. */
  overdue: number
}

export type CalendarWeek = {
  /** The week's first date: stable, so rows reconcile across a month change. */
  key: ISODate
  days: CalendarDay[]
}

export type MonthGrid = {
  /** The first of the month on show. */
  month: ISODate
  /** 'September 2026'. */
  title: string
  /** Always six, so the grid never changes height as the months go by. */
  weeks: CalendarWeek[]
  weekdays: { short: string; long: string }[]
}

export type CalendarOptions = { weekStart?: WeekStart }

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

/** The first of the month `iso` falls in. */
export function firstOfMonth(iso: ISODate): ISODate {
  const { y, m } = parseISODate(iso)
  return formatISODate(y, m, 1)
}

/** 'September 2026'. */
export function monthTitle(month: ISODate): string {
  const { y, m } = parseISODate(month)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/**
 * A day's heading in the agenda and above the day list: 'Today · Sunday 6
 * September'. The relative word comes first because it is the part being
 * looked for; the date is what disambiguates it.
 */
export function dayHeading(date: ISODate, today: ISODate): string {
  const named = `${WEEKDAY_NAMES[weekday(date)]} ${formatLongDate(date, today)}`
  const delta = daysBetween(today, date)
  if (delta === 0) return `Today · ${named}`
  if (delta === 1) return `Tomorrow · ${named}`
  if (delta === -1) return `Yesterday · ${named}`
  return named
}

/** Weekday column headings, rotated into the user's week. */
export function weekdayHeadings(weekStart: WeekStart): { short: string; long: string }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const long = WEEKDAY_NAMES[(weekStart + i) % 7]!
    return { short: long.slice(0, 3), long }
  })
}

// ---- keyboard --------------------------------------------------------------

/**
 * Where a key press moves the focused day, or null when the key is not one of
 * ours.
 *
 * Lives here rather than in the component because the month grid and the
 * agenda both navigate by day and must do it identically: arrows by a day and
 * by a week, Page Up/Down by a month, Home/End to the week's edges, and — the
 * convention every date grid follows — Shift with the page keys by a year.
 */
export function stepDate(
  date: ISODate,
  key: string,
  weekStart: WeekStart,
  shift = false,
): ISODate | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(date, -1)
    case 'ArrowRight':
      return addDays(date, 1)
    case 'ArrowUp':
      return addDays(date, -7)
    case 'ArrowDown':
      return addDays(date, 7)
    case 'PageUp':
      return addMonths(date, shift ? -12 : -1)
    case 'PageDown':
      return addMonths(date, shift ? 12 : 1)
    case 'Home':
      return startOfWeek(date, weekStart)
    case 'End':
      return endOfWeek(date, weekStart)
    default:
      return null
  }
}

// ---- attribution -----------------------------------------------------------

/**
 * The task each rule belongs to.
 *
 * Most rules are pointed at by a task directly. A rule left behind by a "this
 * and all future" split is not: `splitSeries` ends the original the day before
 * the new one starts and moves the task onto the new rule, and the original
 * survives only when it carries the completions recorded against it — which is
 * exactly the history this view exists to draw.
 *
 * The only link back is the shape the split itself created: the original ends
 * on the day before its successor starts. Following that chain is what lets a
 * completion from before an edit keep its title. Two rules starting on the same
 * day are ambiguous, so that date links to nothing rather than to the wrong
 * series — a mis-titled entry is worse than a missing one.
 */
function ownersByRule(state: State): Map<string, Task> {
  const direct = new Map<string, Task>()
  for (const task of state.tasks) {
    if (task.parentId === null && task.recurrenceId !== null) direct.set(task.recurrenceId, task)
  }

  const successors = new Map<ISODate, Recurrence | null>()
  for (const rule of state.recurrences) {
    successors.set(rule.starts, successors.has(rule.starts) ? null : rule)
  }

  const owners = new Map(direct)
  for (const rule of state.recurrences) {
    if (owners.has(rule.id)) continue
    const seen = new Set<string>([rule.id])
    let cursor: Recurrence | null = rule
    while (cursor && cursor.ends.type === 'until') {
      const next: Recurrence | null = successors.get(addDays(cursor.ends.date, 1)) ?? null
      if (!next || seen.has(next.id)) break
      seen.add(next.id)
      const owner = direct.get(next.id)
      if (owner) {
        owners.set(rule.id, owner)
        break
      }
      cursor = next
    }
  }
  return owners
}

// ---- entries ---------------------------------------------------------------

function compareEntries(a: CalendarEntry, b: CalendarEntry): number {
  // A timed thing happens at a time; an untimed one is just "that day", so it
  // sits after everything with a clock on it rather than at 00:00.
  if ((a.dueTime === null) !== (b.dueTime === null)) return a.dueTime === null ? 1 : -1
  if (a.dueTime !== null && b.dueTime !== null && a.dueTime !== b.dueTime) {
    return a.dueTime < b.dueTime ? -1 : 1
  }
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  return a.title.localeCompare(b.title)
}

function entryFromTask(task: Task, today: ISODate): CalendarEntry {
  return {
    key: `${task.id}:${task.due}`,
    taskId: task.id,
    title: task.title,
    date: task.due!,
    dueTime: task.dueTime,
    priority: task.priority,
    projectId: task.projectId,
    repeats: false,
    status: task.done ? 'completed' : 'pending',
    actionable: !task.done,
    overdue: !task.done && compareDates(task.due!, today) < 0,
  }
}

/**
 * Everything falling in `[start, end]`, keyed by the day it falls on.
 *
 * Plain tasks come from their `due`; repeating ones come from their rule, never
 * from the task's `due`, so that the occurrence either side of the current one
 * appears too. A task whose `recurrenceId` no longer resolves falls back to its
 * due date rather than vanishing off the calendar.
 *
 * Occurrences of a rule no task points at — the far half of a split series —
 * are included when they are *finished*: they are the record of what was done
 * before the rule changed. Their pending dates are not, because nothing can act
 * on them and a checkbox that does nothing is worse than a blank square.
 */
export function entriesBetween(
  state: State,
  start: ISODate,
  end: ISODate,
  today: ISODate,
  opts?: CalendarOptions,
): Map<ISODate, CalendarEntry[]> {
  const span = daysBetween(start, end)
  if (span < 0) throw new RangeError(`window ends before it starts: ${start}..${end}`)
  if (span + 1 > MAX_WINDOW_DAYS) {
    throw new RangeError(`window of ${span + 1} days exceeds the ${MAX_WINDOW_DAYS}-day limit`)
  }
  const cap = Math.min(MAX_PER_RULE, span + 1)

  const byDay = new Map<ISODate, CalendarEntry[]>()
  const push = (entry: CalendarEntry): void => {
    const day = byDay.get(entry.date)
    if (day) day.push(entry)
    else byDay.set(entry.date, [entry])
  }

  const rules = new Map(state.recurrences.map((r) => [r.id, r]))

  for (const task of state.tasks) {
    // Subtasks belong to their parent's row, never to a day of their own.
    if (task.parentId !== null || task.due === null) continue
    if (task.recurrenceId !== null && rules.has(task.recurrenceId)) continue
    if (compareDates(task.due, start) < 0 || compareDates(task.due, end) > 0) continue
    push(entryFromTask(task, today))
  }

  const owners = ownersByRule(state)

  for (const rule of state.recurrences) {
    const task = owners.get(rule.id)
    if (!task) continue
    const live = task.recurrenceId === rule.id

    for (const occurrence of occurrencesBetween(rule, start, end, cap, opts)) {
      if (!live && occurrence.status === 'pending') continue
      const current = live && !task.done && occurrence.date === task.due
      push({
        // The generated date, not the moved-to one: it is what identifies the
        // occurrence, and it is what stops a move from colliding with whatever
        // already sits on the destination day.
        key: `${task.id}:${occurrence.movedFrom ?? occurrence.date}`,
        taskId: task.id,
        title: task.title,
        date: occurrence.date,
        dueTime: task.dueTime,
        priority: task.priority,
        projectId: task.projectId,
        repeats: true,
        status: occurrence.status,
        actionable: current,
        overdue:
          occurrence.status !== 'completed' &&
          occurrence.status !== 'skipped' &&
          compareDates(occurrence.date, today) < 0,
      })
    }
  }

  for (const entries of byDay.values()) entries.sort(compareEntries)
  return byDay
}

function dayFrom(
  date: ISODate,
  entries: CalendarEntry[],
  today: ISODate,
  month: ISODate | null,
): CalendarDay {
  let pending = 0
  let overdue = 0
  for (const entry of entries) {
    if (entry.status === 'completed' || entry.status === 'skipped') continue
    pending += 1
    if (entry.overdue) overdue += 1
  }
  const day = weekday(date)
  return {
    date,
    dayOfMonth: parseISODate(date).d,
    inMonth: month === null || date.slice(0, 7) === month.slice(0, 7),
    isToday: date === today,
    isWeekend: day === 0 || day === 6,
    entries,
    pending,
    overdue,
  }
}

/** Every day in `[start, end]`, empty ones included. An empty week is information. */
export function agendaDays(
  state: State,
  start: ISODate,
  end: ISODate,
  today: ISODate,
  opts?: CalendarOptions,
): CalendarDay[] {
  return agendaIn(calendarWindow(state, start, end, today, opts), start, end)
}

/**
 * One fetch, carried around.
 *
 * The grid, the agenda and the selected day's panel are all on screen at once
 * and all want the same days. Each calling `entriesBetween` for itself means
 * walking every rule in the state two or three times per render, and the day
 * panel — one day wide — pays the same per-rule cost as the whole month.
 *
 * So the component fetches once into a `CalendarWindow` and shapes it three
 * ways. `monthGrid`, `agendaDays` and `dayDetail` remain as the fetch-and-shape
 * convenience wrappers, which is what makes the pure tests read as one call.
 */
export type CalendarWindow = {
  start: ISODate
  end: ISODate
  today: ISODate
  entries: ReadonlyMap<ISODate, CalendarEntry[]>
}

export function calendarWindow(
  state: State,
  start: ISODate,
  end: ISODate,
  today: ISODate,
  opts?: CalendarOptions,
): CalendarWindow {
  return { start, end, today, entries: entriesBetween(state, start, end, today, opts) }
}

/** The window a month grid needs: six whole weeks, plus the margin either side. */
export function monthWindowFor(month: ISODate, weekStart: WeekStart): { start: ISODate; end: ISODate } {
  const start = startOfWeek(firstOfMonth(month), weekStart)
  return {
    start: addDays(start, -WINDOW_MARGIN_DAYS),
    end: addDays(start, 41 + WINDOW_MARGIN_DAYS),
  }
}

export function covers(window: CalendarWindow, date: ISODate): boolean {
  return compareDates(date, window.start) >= 0 && compareDates(date, window.end) <= 0
}

/** One day out of a window already fetched. Null when the window does not reach it. */
export function dayIn(window: CalendarWindow, date: ISODate): CalendarDay | null {
  if (!covers(window, date)) return null
  return dayFrom(date, window.entries.get(date) ?? [], window.today, null)
}

/** The six-week grid, shaped from a window that already covers it. */
export function monthGridIn(window: CalendarWindow, month: ISODate, weekStart: WeekStart): MonthGrid {
  const first = firstOfMonth(month)
  const start = startOfWeek(first, weekStart)

  const weeks: CalendarWeek[] = []
  for (let w = 0; w < 6; w += 1) {
    const weekStartDate = addDays(start, w * 7)
    const days: CalendarDay[] = []
    for (let d = 0; d < 7; d += 1) {
      const date = addDays(weekStartDate, d)
      days.push(dayFrom(date, window.entries.get(date) ?? [], window.today, first))
    }
    weeks.push({ key: weekStartDate, days })
  }

  return { month: first, title: monthTitle(first), weeks, weekdays: weekdayHeadings(weekStart) }
}

/** Every day in `[start, end]`, shaped from a window that already covers it. */
export function agendaIn(window: CalendarWindow, start: ISODate, end: ISODate): CalendarDay[] {
  const days: CalendarDay[] = []
  for (let cursor = start; compareDates(cursor, end) <= 0; cursor = addDays(cursor, 1)) {
    days.push(dayFrom(cursor, window.entries.get(cursor) ?? [], window.today, null))
  }
  return days
}

/**
 * The six-week grid for the month `month` falls in.
 *
 * Six rows always, so the grid does not change height between a February that
 * fits in four and a March that needs six — a control that resizes under the
 * pointer is a control you cannot aim at.
 */
export function monthGrid(
  state: State,
  month: ISODate,
  today: ISODate,
  weekStart: WeekStart,
  opts?: CalendarOptions,
): MonthGrid {
  // The margin is fetched, not drawn: the day panel is usually showing a day
  // on this grid and sometimes one just off it, and either way it reads from
  // this map rather than walking every rule again for one day.
  const { start, end } = monthWindowFor(month, weekStart)
  const window = calendarWindow(state, start, end, today, { weekStart, ...opts })
  return monthGridIn(window, month, weekStart)
}

/** One day, fully populated — what the list under the grid shows. */
export function dayDetail(
  state: State,
  date: ISODate,
  today: ISODate,
  opts?: CalendarOptions,
): CalendarDay {
  const entries = entriesBetween(state, date, date, today, opts)
  return dayFrom(date, entries.get(date) ?? [], today, null)
}

/**
 * How the agenda describes a day's load in one phrase, for the row and for the
 * screen reader that will not see the dots.
 */
export function dayLoadLabel(day: CalendarDay): string {
  if (day.entries.length === 0) return 'Nothing scheduled'

  let done = 0
  let skipped = 0
  for (const entry of day.entries) {
    if (entry.status === 'completed') done += 1
    else if (entry.status === 'skipped') skipped += 1
  }

  const parts: string[] = []
  if (day.pending > 0) parts.push(`${day.pending} ${day.pending === 1 ? 'task' : 'tasks'}`)
  if (day.overdue > 0) parts.push(`${day.overdue} overdue`)
  // Done and skipped are counted apart, not summed as "finished". A cell shows
  // its statuses as three dot shapes and nothing else at narrow widths, so this
  // string is the *only* place a screen reader can learn that an occurrence was
  // waved away rather than completed — and those are not the same day.
  if (done > 0) parts.push(`${done} done`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  return parts.join(', ')
}
