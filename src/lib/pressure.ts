/**
 * The two numbers the shader reads.
 *
 * Both are pure functions of the open task list and an explicitly supplied
 * "today" — nothing here reads the clock.
 */
import { daysBetween } from './dates.ts'
import type { ISODate, PressureLabel, PressureSummary, Priority, Task } from './types.ts'

const PRIORITY_WEIGHT: Record<Priority, number> = {
  none: 1,
  low: 1.5,
  medium: 2.5,
  high: 4,
  urgent: 6,
}

/**
 * The saturation constant. Chosen so a realistic busy day — roughly fourteen
 * open tasks with a few overdue and a few due today, a raw load near 70 — lands
 * around 0.6 rather than pinning at 1: k = 70 / ln(2.5) ~= 76.
 *
 * The curve matters more than the constant. Linear normalisation would make
 * twenty tasks look like two hundred and would jolt the surface every time a
 * single task joined a short list.
 */
export const K = 75

/** How late something is, capped so a two-week-old task and a year-old one agree. */
const OVERDUE_CAP_DAYS = 14

function urgency(due: ISODate | null, today: ISODate): number {
  if (due === null) return 1
  const daysUntil = daysBetween(today, due)
  if (daysUntil < 0) return 2 + Math.min(-daysUntil, OVERDUE_CAP_DAYS) / 7
  if (daysUntil === 0) return 2
  if (daysUntil <= 3) return 1.5
  return 1.1
}

/**
 * Only open, top-level tasks count. Subtasks are checklist items with no due
 * date, project, or recurrence of their own (see Phase 4), so a twenty-item
 * checklist is one commitment on the plate, not twenty.
 */
function counts(t: Task): boolean {
  return !t.done && t.parentId === null
}

export function computePressure(tasks: readonly Task[], today: ISODate): PressureSummary {
  let load = 0
  let overdueLoad = 0
  let openCount = 0
  let overdueCount = 0

  for (const t of tasks) {
    if (!counts(t)) continue
    openCount += 1
    const contribution = PRIORITY_WEIGHT[t.priority] * urgency(t.due, today)
    load += contribution
    if (t.due !== null && daysBetween(today, t.due) < 0) {
      overdueLoad += contribution
      overdueCount += 1
    }
  }

  return {
    // Saturating, never linear: the marginal task always moves the surface less
    // than the one before it.
    pressure: load === 0 ? 0 : 1 - Math.exp(-load / K),
    // The fraction of load that is late, not the fraction of tasks: one overdue
    // urgent item outweighs three undated trivial ones, which is how it feels.
    heat: load === 0 ? 0 : overdueLoad / load,
    load,
    openCount,
    overdueCount,
  }
}

/** The words behind the colour, so the surface always has a text equivalent. */
export function pressureLabel(pressure: number): PressureLabel {
  if (pressure < 0.15) return 'Calm'
  if (pressure < 0.4) return 'Steady'
  if (pressure < 0.7) return 'Busy'
  return 'Heavy'
}
