/**
 * Calendar-day arithmetic on 'YYYY-MM-DD' strings.
 *
 * Everything here runs on integer day numbers (Howard Hinnant's days-from-civil
 * / civil-from-days). `Date` appears in exactly one function, `toISODate`, and
 * no arithmetic ever passes through it — so there is no DST or timezone hazard
 * anywhere in this module.
 */
import type { ISODate, WeekStart, Weekday } from './types.ts'

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** Days in month `m` (1-12) of year `y`. */
export function daysInMonth(y: number, m: number): number {
  if (m < 1 || m > 12) throw new RangeError(`month out of range: ${m}`)
  if (m === 2 && isLeapYear(y)) return 29
  return MONTH_LENGTHS[m - 1]!
}

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false
  const match = ISO_RE.exec(value)
  if (!match) return false
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12) return false
  return d >= 1 && d <= daysInMonth(y, m)
}

function assertISO(value: ISODate): void {
  if (!isISODate(value)) throw new RangeError(`not a YYYY-MM-DD date: ${value}`)
}

export type DateParts = { y: number; m: number; d: number }

export function parseISODate(iso: ISODate): DateParts {
  assertISO(iso)
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) }
}

export function formatISODate(y: number, m: number, d: number): ISODate {
  const yy = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0')
  return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Days since 1970-01-01. Pure integer arithmetic, valid far beyond any use here. */
export function epochDay(iso: ISODate): number {
  const { y, m, d } = parseISODate(iso)
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function fromEpochDay(days: number): ISODate {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return formatISODate(m <= 2 ? y + 1 : y, m, d)
}

/**
 * Today, from an explicitly supplied clock reading. Reads the *local* calendar
 * parts: `toISOString()` is UTC and yields the wrong day for anyone west of
 * Greenwich for part of every day.
 */
export function toISODate(now: Date): ISODate {
  return formatISODate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function addDays(iso: ISODate, n: number): ISODate {
  return fromEpochDay(epochDay(iso) + n)
}

/** Signed day count from `a` to `b`; positive when `b` is later. */
export function daysBetween(a: ISODate, b: ISODate): number {
  return epochDay(b) - epochDay(a)
}

export function compareDates(a: ISODate, b: ISODate): number {
  assertISO(a)
  assertISO(b)
  return a < b ? -1 : a > b ? 1 : 0
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return compareDates(a, b) <= 0 ? a : b
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return compareDates(a, b) >= 0 ? a : b
}

/**
 * Add `n` months, clamping the day to the target month's length: Jan 31 + 1
 * month is Feb 28 (or Feb 29 in a leap year). Always call this from the
 * original anchor date, never iteratively from the previous result, or the
 * clamp becomes sticky and the series drifts.
 */
export function addMonths(iso: ISODate, n: number): ISODate {
  const { y, m, d } = parseISODate(iso)
  const total = y * 12 + (m - 1) + n
  const ty = Math.floor(total / 12)
  const tm = total - ty * 12 + 1
  return formatISODate(ty, tm, Math.min(d, daysInMonth(ty, tm)))
}

/** Add `n` years, clamping 29 February to 28 February in common years. */
export function addYears(iso: ISODate, n: number): ISODate {
  return addMonths(iso, n * 12)
}

/** 0 = Sunday. 1970-01-01 was a Thursday. */
export function weekday(iso: ISODate): Weekday {
  return (((epochDay(iso) + 4) % 7 + 7) % 7) as Weekday
}

export function startOfWeek(iso: ISODate, weekStart: WeekStart): ISODate {
  const back = ((weekday(iso) - weekStart) % 7 + 7) % 7
  return addDays(iso, -back)
}

export function endOfWeek(iso: ISODate, weekStart: WeekStart): ISODate {
  return addDays(startOfWeek(iso, weekStart), 6)
}

/**
 * '14:05' -> '2:05 pm'. Returns null for anything that is not a valid 'HH:mm',
 * so a caller can omit the label rather than print nonsense.
 *
 * Lives here, at the bottom of the stack, because both the quick-add preview
 * and the task row show a time and they must not drift apart: a chip reading
 * "09:00" while the row beside it reads "9 am" is the kind of small
 * inconsistency that makes an interface feel unfinished.
 */
export function formatTimeOfDay(hhmm: string | null): string | null {
  if (hhmm === null) return null
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  const suffix = h < 12 ? 'am' : 'pm'
  const hour = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * '2026-12-15' -> '15 December 2026', or '15 December' when it falls in
 * `relativeTo`'s year.
 *
 * Lives beside `formatTimeOfDay` and for the same reason: the recurrence
 * editor's summary, its occurrence preview and the task row all name a date in
 * prose, and a summary reading "until 2026-12-15" beside a preview reading
 * "15 December" is the kind of small inconsistency that makes an interface
 * feel unfinished.
 */
export function formatLongDate(iso: ISODate, relativeTo?: ISODate): string {
  const { y, m, d } = parseISODate(iso)
  const sameYear = relativeTo !== undefined && parseISODate(relativeTo).y === y
  return sameYear ? `${d} ${MONTH_NAMES[m - 1]}` : `${d} ${MONTH_NAMES[m - 1]} ${y}`
}
