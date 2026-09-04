/** Every date in state is a 'YYYY-MM-DD' calendar day, never a Date. */
export type ISODate = string

/** An ISO 8601 instant, e.g. '2026-09-04T10:15:00.000Z'. */
export type ISOInstant = string

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export type Task = {
  id: string
  title: string
  notes: string
  done: boolean
  completedAt: ISOInstant | null
  due: ISODate | null
  dueTime: string | null // 'HH:mm'
  priority: Priority
  projectId: string | null
  tagIds: string[]
  parentId: string | null // subtasks: one level only, not a tree
  order: number
  recurrenceId: string | null
  createdAt: ISOInstant
}

export type Project = {
  id: string
  name: string
  colorToken: string
  icon: string
  archived: boolean
  order: number
}

export type Tag = {
  id: string
  name: string
  colorToken: string
}

/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** The parity basis for weekly rules (RFC 5545 WKST). Sunday or Monday. */
export type WeekStart = 0 | 1

export type RecurrenceEnd =
  | { type: 'never' }
  | { type: 'after'; count: number }
  | { type: 'until'; date: ISODate }

export type RecurrenceException = {
  /** The occurrence date being modified, always the *generated* date. */
  date: ISODate
  kind: 'skipped' | 'completed' | 'moved'
  movedTo?: ISODate
  completedAt?: ISOInstant
}

export type Recurrence = {
  id: string
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  byWeekday?: number[]
  byMonthDay?: number
  byNthWeekday?: { nth: number; weekday: number }
  byMonth?: number
  starts: ISODate
  /**
   * Seeded from settings.weekStartsOn when the rule is created and never
   * re-read from settings, so changing the preference cannot retroactively
   * shift an existing rule. Only affects rules with interval >= 2.
   */
  weekStart?: WeekStart
  ends: RecurrenceEnd
  exceptions: RecurrenceException[]
}

export type OccurrenceStatus = 'pending' | 'completed' | 'skipped' | 'moved'

export type Occurrence = {
  /** The final date: the moved-to date for a moved occurrence. */
  date: ISODate
  /** 0-based index within the series, counted from `starts`. */
  seq: number
  status: OccurrenceStatus
  /** Present when status is 'moved': the originally generated date. */
  movedFrom?: ISODate
  /** Present when status is 'moved'; equal to `date` by construction. */
  movedTo?: ISODate
  completedAt?: ISOInstant
}

export type Settings = {
  schemaVersion: number
  theme: 'dark' | 'light' | 'system'
  effects: 'full' | 'reduced' | 'off'
  weekStartsOn: WeekStart
  defaultProjectId: string | null
}

export type State = {
  settings: Settings
  tasks: Task[]
  projects: Project[]
  tags: Tag[]
  recurrences: Recurrence[]
}

export type PressureSummary = {
  /** 0..1, saturating. Drives noise frequency, warp and flow speed. */
  pressure: number
  /** 0..1, the fraction of raw load that is overdue. Drives the palette. */
  heat: number
  /** The un-normalised sum of weight x urgency over open top-level tasks. */
  load: number
  openCount: number
  overdueCount: number
}

export type PressureLabel = 'Calm' | 'Steady' | 'Busy' | 'Heavy'

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
