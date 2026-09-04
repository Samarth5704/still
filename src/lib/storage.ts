/**
 * Reading persisted state back, defensively.
 *
 * Pure: this module parses and validates a string. Touching localStorage is the
 * app's job (Phase 3), which keeps lib/ free of globals and makes every failure
 * mode here testable.
 */
import { isISODate } from './dates.ts'
import type { Priority, Project, Recurrence, Settings, State, Tag, Task } from './types.ts'

export const SCHEMA_VERSION = 1

export function defaultSettings(): Settings {
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: 'system',
    effects: 'full',
    weekStartsOn: 1,
    defaultProjectId: null,
  }
}

export function defaultState(): State {
  return { settings: defaultSettings(), tasks: [], projects: [], tags: [], recurrences: [] }
}

export type LoadResult = {
  state: State
  /**
   * 'read-only' means the stored data came from a newer build. The caller must
   * not write back: overwriting it would destroy data this version cannot read.
   */
  mode: 'read-write' | 'read-only'
  reason?: 'empty' | 'malformed' | 'future-schema'
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback

const isoDateOrNull = (v: unknown): string | null => (isISODate(v) ? v : null)

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const

function parseTask(raw: unknown): Task | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    title: str(raw.title, ''),
    notes: str(raw.notes, ''),
    done: bool(raw.done, false),
    completedAt: nullableStr(raw.completedAt),
    due: isoDateOrNull(raw.due),
    dueTime: nullableStr(raw.dueTime),
    priority: oneOf<Priority>(raw.priority, PRIORITIES, 'none'),
    projectId: nullableStr(raw.projectId),
    tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.filter((t): t is string => typeof t === 'string') : [],
    parentId: nullableStr(raw.parentId),
    order: num(raw.order, 0),
    recurrenceId: nullableStr(raw.recurrenceId),
    createdAt: str(raw.createdAt, '1970-01-01T00:00:00.000Z'),
  }
}

function parseProject(raw: unknown): Project | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    name: str(raw.name, 'Untitled'),
    colorToken: str(raw.colorToken, 'slate'),
    icon: str(raw.icon, 'circle'),
    archived: bool(raw.archived, false),
    order: num(raw.order, 0),
  }
}

function parseTag(raw: unknown): Tag | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  return { id: raw.id, name: str(raw.name, 'untitled'), colorToken: str(raw.colorToken, 'slate') }
}

function parseRecurrence(raw: unknown): Recurrence | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isISODate(raw.starts)) return null
  const ends = isRecord(raw.ends) ? raw.ends : { type: 'never' }
  const rule: Recurrence = {
    id: raw.id,
    freq: oneOf(raw.freq, ['daily', 'weekly', 'monthly', 'yearly'] as const, 'daily'),
    interval: Math.max(1, Math.trunc(num(raw.interval, 1))),
    starts: raw.starts,
    // A rule stored before weekStart existed keeps its dates by defaulting to
    // Monday, which is what the generator assumed at the time.
    weekStart: raw.weekStart === 0 ? 0 : 1,
    ends:
      ends.type === 'after'
        ? { type: 'after', count: Math.max(0, Math.trunc(num(ends.count, 1))) }
        : ends.type === 'until' && isISODate(ends.date)
          ? { type: 'until', date: ends.date }
          : { type: 'never' },
    exceptions: Array.isArray(raw.exceptions)
      ? raw.exceptions.flatMap((e) => {
          if (!isRecord(e) || !isISODate(e.date)) return []
          const kind = oneOf(e.kind, ['skipped', 'completed', 'moved'] as const, 'skipped')
          const exception: Recurrence['exceptions'][number] = { date: e.date, kind }
          if (kind === 'moved' && isISODate(e.movedTo)) exception.movedTo = e.movedTo
          if (kind === 'completed' && typeof e.completedAt === 'string') {
            exception.completedAt = e.completedAt
          }
          return [exception]
        })
      : [],
  }
  if (Array.isArray(raw.byWeekday)) {
    rule.byWeekday = raw.byWeekday.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
  }
  if (typeof raw.byMonthDay === 'number') rule.byMonthDay = raw.byMonthDay
  if (typeof raw.byMonth === 'number') rule.byMonth = raw.byMonth
  if (isRecord(raw.byNthWeekday) && typeof raw.byNthWeekday.nth === 'number' && typeof raw.byNthWeekday.weekday === 'number') {
    rule.byNthWeekday = { nth: raw.byNthWeekday.nth, weekday: raw.byNthWeekday.weekday }
  }
  return rule
}

function parseSettings(raw: unknown): Settings {
  const base = defaultSettings()
  if (!isRecord(raw)) return base
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: oneOf(raw.theme, ['dark', 'light', 'system'] as const, base.theme),
    effects: oneOf(raw.effects, ['full', 'reduced', 'off'] as const, base.effects),
    weekStartsOn: raw.weekStartsOn === 0 ? 0 : 1,
    defaultProjectId: nullableStr(raw.defaultProjectId),
  }
}

function parseArray<T>(raw: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(raw) ? raw.flatMap((item) => { const parsed = parse(item); return parsed ? [parsed] : [] }) : []
}

/**
 * Parse persisted state, falling back to defaults on anything unreadable.
 * Never throws: bad storage must not stop the app from opening.
 */
export function parseState(raw: string | null): LoadResult {
  if (raw === null || raw.trim() === '') {
    return { state: defaultState(), mode: 'read-write', reason: 'empty' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: defaultState(), mode: 'read-write', reason: 'malformed' }
  }
  if (!isRecord(parsed)) {
    return { state: defaultState(), mode: 'read-write', reason: 'malformed' }
  }

  const storedVersion = isRecord(parsed.settings) ? num(parsed.settings.schemaVersion, SCHEMA_VERSION) : SCHEMA_VERSION
  if (storedVersion > SCHEMA_VERSION) {
    // Written by a newer build. Open read-only rather than reading it wrongly
    // and writing our misreading back over the top.
    return { state: defaultState(), mode: 'read-only', reason: 'future-schema' }
  }

  return {
    state: {
      settings: parseSettings(parsed.settings),
      tasks: parseArray(parsed.tasks, parseTask),
      projects: parseArray(parsed.projects, parseProject),
      tags: parseArray(parsed.tags, parseTag),
      recurrences: parseArray(parsed.recurrences, parseRecurrence),
    },
    mode: 'read-write',
  }
}

export function serialiseState(state: State): string {
  return JSON.stringify({ ...state, settings: { ...state.settings, schemaVersion: SCHEMA_VERSION } })
}
