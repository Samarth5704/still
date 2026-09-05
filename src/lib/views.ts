/**
 * Which tasks a view shows, in what order, under what headings.
 *
 * Pure, like everything in lib/: `today` arrives as an argument. The app owns
 * the URL and the DOM; this module owns the answer to "what belongs on screen".
 */
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addDays,
  compareDates,
  daysBetween,
  epochDay,
  formatTimeOfDay,
  isISODate,
  parseISODate,
  weekday,
} from './dates.ts'
import type { ISODate, Priority, State, Task, WeekStart } from './types.ts'

export type View =
  | { kind: 'today' }
  | { kind: 'upcoming' }
  | { kind: 'all' }
  /**
   * `day` is the day the grid has filtered its list to, and it lives in the
   * view — and therefore in the URL — rather than inside the calendar
   * component, so a day someone is looking at can be linked and survives a
   * reload. `null` means the calendar picks today.
   */
  | { kind: 'calendar'; day: ISODate | null }
  | { kind: 'project'; id: string }
  | { kind: 'tag'; id: string }

export type TaskGroup = {
  /** Stable across renders, so the list can reconcile rather than rebuild. */
  key: string
  title: string
  /** Set on the group a task is overdue in, so the UI can mark it without re-deriving. */
  tone: 'overdue' | 'today' | 'soon' | 'later' | 'none'
  tasks: Task[]
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

/** Open, top-level tasks. Subtasks belong to their parent's row, never to a list. */
function isListable(t: Task): boolean {
  return !t.done && t.parentId === null
}

/**
 * Dated before undated, earlier before later, then by priority, then by the
 * user's manual order. Manual order is last so it can never fight a due date:
 * a task due today outranks one dragged to the top with no date at all.
 */
export function compareTasks(a: Task, b: Task): number {
  if (a.due !== b.due) {
    if (a.due === null) return 1
    if (b.due === null) return -1
    const byDate = compareDates(a.due, b.due)
    if (byDate !== 0) return byDate
  }
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  if (a.order !== b.order) return a.order - b.order
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
}

/** Manual order first: this is what a project list uses. */
export function compareManual(a: Task, b: Task): number {
  if (a.order !== b.order) return a.order - b.order
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
}

export function tasksForView(state: State, view: View, today: ISODate): Task[] {
  const open = state.tasks.filter(isListable)

  switch (view.kind) {
    case 'today':
      // Everything that has come due, including what came due before today.
      // Hiding the overdue pile in another view is how it gets forgotten.
      return open.filter((t) => t.due !== null && compareDates(t.due, today) <= 0).sort(compareTasks)
    case 'upcoming':
      return open.filter((t) => t.due !== null && compareDates(t.due, today) > 0).sort(compareTasks)
    case 'all':
      return open.sort(compareTasks)
    case 'project':
      return open.filter((t) => t.projectId === view.id).sort(compareManual)
    case 'tag':
      return open.filter((t) => t.tagIds.includes(view.id)).sort(compareTasks)
    case 'calendar':
      return open.filter((t) => t.due !== null).sort(compareTasks)
  }
}

type Bucket = { key: string; title: string; tone: TaskGroup['tone'] }

/**
 * The heading a due date falls under. Relative labels only reach a week out —
 * past that, "in 23 days" is harder to act on than the actual date.
 */
export function bucketFor(due: ISODate | null, today: ISODate, weekStart: WeekStart): Bucket {
  if (due === null) return { key: 'none', title: 'No date', tone: 'none' }

  const delta = daysBetween(today, due)
  if (delta < 0) return { key: 'overdue', title: 'Overdue', tone: 'overdue' }
  if (delta === 0) return { key: 'today', title: 'Today', tone: 'today' }
  if (delta === 1) return { key: `d:${due}`, title: 'Tomorrow', tone: 'soon' }

  // Inside the coming week, a weekday name is the most readable label there is.
  const daysLeftThisWeek = 7 - (((weekday(today) - weekStart) % 7 + 7) % 7)
  if (delta < daysLeftThisWeek) {
    return { key: `d:${due}`, title: WEEKDAY_NAMES[weekday(due)]!, tone: 'soon' }
  }
  if (delta < daysLeftThisWeek + 7) {
    return { key: `d:${due}`, title: `Next ${WEEKDAY_NAMES[weekday(due)]}`, tone: 'later' }
  }

  const { y, m, d } = parseISODate(due)
  const sameYear = parseISODate(today).y === y
  const title = sameYear ? `${d} ${MONTH_NAMES[m - 1]}` : `${d} ${MONTH_NAMES[m - 1]} ${y}`
  return { key: `d:${due}`, title, tone: 'later' }
}

/**
 * Group a sorted task list under date headings, preserving the incoming order
 * within each group and emitting groups in first-appearance order.
 */
export function groupByDue(tasks: readonly Task[], today: ISODate, weekStart: WeekStart): TaskGroup[] {
  const groups: TaskGroup[] = []
  const byKey = new Map<string, TaskGroup>()

  for (const task of tasks) {
    const bucket = bucketFor(task.due, today, weekStart)
    let group = byKey.get(bucket.key)
    if (!group) {
      group = { key: bucket.key, title: bucket.title, tone: bucket.tone, tasks: [] }
      byKey.set(bucket.key, group)
      groups.push(group)
    }
    group.tasks.push(task)
  }

  return groups
}

/** A project list is one unheaded group: its order is the user's, not the calendar's. */
export function groupsForView(
  state: State,
  view: View,
  today: ISODate,
  weekStart: WeekStart,
): TaskGroup[] {
  const tasks = tasksForView(state, view, today)
  if (view.kind === 'project') {
    return tasks.length === 0 ? [] : [{ key: 'project', title: '', tone: 'none', tasks }]
  }
  return groupByDue(tasks, today, weekStart)
}

export type ViewCounts = {
  today: number
  upcoming: number
  all: number
  overdue: number
  byProject: Map<string, number>
  byTag: Map<string, number>
}

/** One pass over the open tasks for every badge in the sidebar. */
export function viewCounts(state: State, today: ISODate): ViewCounts {
  const counts: ViewCounts = {
    today: 0,
    upcoming: 0,
    all: 0,
    overdue: 0,
    byProject: new Map(),
    byTag: new Map(),
  }

  for (const t of state.tasks) {
    if (!isListable(t)) continue
    counts.all += 1
    if (t.due !== null) {
      const delta = daysBetween(today, t.due)
      if (delta < 0) {
        counts.overdue += 1
        counts.today += 1
      } else if (delta === 0) counts.today += 1
      else counts.upcoming += 1
    }
    if (t.projectId !== null) {
      counts.byProject.set(t.projectId, (counts.byProject.get(t.projectId) ?? 0) + 1)
    }
    for (const tag of t.tagIds) counts.byTag.set(tag, (counts.byTag.get(tag) ?? 0) + 1)
  }

  return counts
}

/**
 * The next `order` value for a list, so a new task lands at the end rather than
 * colliding with an existing one.
 */
export function nextOrder(tasks: readonly Task[], projectId: string | null): number {
  let max = -1
  for (const t of tasks) {
    if (t.parentId === null && t.projectId === projectId && t.order > max) max = t.order
  }
  return max + 1
}

/**
 * Move `id` one step within its manually-ordered siblings, returning the tasks
 * with rewritten `order` values. Returns the input unchanged at either end.
 *
 * Orders are rewritten densely from 0 rather than swapped, because imported or
 * hand-edited state can arrive with duplicate order values and a swap would
 * make that permanent.
 */
export function reorder(tasks: readonly Task[], id: string, direction: -1 | 1): Task[] {
  const target = tasks.find((t) => t.id === id)
  if (!target || target.parentId !== null) return [...tasks]

  const siblings = tasks
    .filter((t) => t.parentId === null && t.projectId === target.projectId && !t.done)
    .sort(compareManual)

  const from = siblings.findIndex((t) => t.id === id)
  const to = from + direction
  if (from === -1 || to < 0 || to >= siblings.length) return [...tasks]

  const moved = [...siblings]
  const [lifted] = moved.splice(from, 1)
  moved.splice(to, 0, lifted!)

  const orders = new Map(moved.map((t, i) => [t.id, i]))
  return tasks.map((t) => (orders.has(t.id) ? { ...t, order: orders.get(t.id)! } : t))
}

/** Days from today, for the "3 days overdue" style of label. */
export function dueLabel(due: ISODate | null, today: ISODate): string | null {
  if (due === null) return null
  const delta = daysBetween(today, due)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  if (delta === -1) return 'Yesterday'
  if (delta < 0) return `${-delta} days ago`
  if (delta < 7) return WEEKDAY_NAMES[weekday(due)]!
  const { y, m, d } = parseISODate(due)
  return parseISODate(today).y === y ? `${d} ${MONTH_NAMES[m - 1]}` : `${d} ${MONTH_NAMES[m - 1]} ${y}`
}

/** '14:05' -> '2:05 pm'. Returns null for no time, so the caller can omit the chip. */
export const timeLabel = formatTimeOfDay

/** The window a calendar month needs, padded to whole weeks. Used in Phase 6. */
export function monthWindow(month: ISODate, weekStart: WeekStart): { start: ISODate; end: ISODate } {
  const { y, m } = parseISODate(month)
  const first = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`
  const back = ((weekday(first) - weekStart) % 7 + 7) % 7
  const start = addDays(first, -back)
  return { start, end: addDays(start, 41) }
}

/** True when nothing is scheduled and nothing is late: the goal state. */
export function isClear(state: State, today: ISODate): boolean {
  return tasksForView(state, { kind: 'today' }, today).length === 0
}

/** Sort key for a date string, exposed so the calendar and list cannot disagree. */
export function dateOrder(iso: ISODate): number {
  return epochDay(iso)
}

export const DEFAULT_VIEW: View = { kind: 'today' }

/**
 * `#/project/abc` <-> `{ kind: 'project', id: 'abc' }`.
 *
 * Every view is a URL so it can be linked, bookmarked and restored on reload.
 * Anything unrecognised falls back to Today rather than throwing: a stale or
 * hand-edited link should open the app, not break it.
 */
export function parseHash(hash: string): View {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  const [head, rest] = [path.split('/')[0] ?? '', path.split('/').slice(1).join('/')]

  switch (head) {
    case '':
    case 'today':
      return { kind: 'today' }
    case 'upcoming':
      return { kind: 'upcoming' }
    case 'all':
      return { kind: 'all' }
    case 'calendar':
      // `#/calendar/2026-09-06` is a calendar with that day's list showing. A
      // malformed day is dropped rather than rejected: the calendar is still
      // the view the user asked for.
      return { kind: 'calendar', day: isISODate(rest) ? rest : null }
    case 'project':
      return rest ? { kind: 'project', id: decodeURIComponent(rest) } : DEFAULT_VIEW
    case 'tag':
      return rest ? { kind: 'tag', id: decodeURIComponent(rest) } : DEFAULT_VIEW
    default:
      return DEFAULT_VIEW
  }
}

export function formatHash(view: View): string {
  switch (view.kind) {
    case 'project':
      return `#/project/${encodeURIComponent(view.id)}`
    case 'tag':
      return `#/tag/${encodeURIComponent(view.id)}`
    case 'calendar':
      return view.day === null ? '#/calendar' : `#/calendar/${view.day}`
    default:
      return `#/${view.kind}`
  }
}

/**
 * Whether two views are the same *place*.
 *
 * The calendar's selected day is deliberately not compared: the nav link
 * highlights "Calendar" whichever day is showing, and the calendar keeps its
 * own scroll and focus when the day changes underneath it. `sameHash` is the
 * stricter question, and it is the one routing asks.
 */
export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'project' && b.kind === 'project') return a.id === b.id
  if (a.kind === 'tag' && b.kind === 'tag') return a.id === b.id
  return true
}

/** Exact identity, selected day included. */
export function sameHash(a: View, b: View): boolean {
  return formatHash(a) === formatHash(b)
}

/** The heading shown above the list, given the view and the state it names. */
export function viewTitle(view: View, state: State): string {
  switch (view.kind) {
    case 'today':
      return 'Today'
    case 'upcoming':
      return 'Upcoming'
    case 'all':
      return 'All tasks'
    case 'calendar':
      return 'Calendar'
    case 'project':
      return state.projects.find((p) => p.id === view.id)?.name ?? 'Project'
    case 'tag':
      return `@${state.tags.find((t) => t.id === view.id)?.name ?? 'tag'}`
  }
}
