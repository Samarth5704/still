/**
 * The quick-add grammar.
 *
 * Pure: takes the raw string and an explicit `today`, returns what it found.
 * It never reads the clock, never touches the DOM, and never creates anything —
 * resolving `#work` to a project id, or minting a recurrence id, is the app's
 * job. This module only says what the words mean.
 *
 * The parser records the character span of every token it consumes. That is
 * what lets the live preview under the input show exactly what was understood,
 * which is the whole reason this feature is tolerable: a parser you cannot see
 * is a parser you cannot trust.
 *
 * Matching is deliberately non-overlapping and order-sensitive. `every monday`
 * has to be read as a recurrence before `monday` can be read as a due date, so
 * recurrence matchers run first and mark their characters consumed.
 */
import {
  addDays,
  addMonths,
  daysInMonth,
  epochDay,
  formatISODate,
  formatTimeOfDay,
  parseISODate,
  weekday,
} from './dates.ts'
import type { ISODate, Priority, WeekStart } from './types.ts'

/** A recurrence rule with no identity yet: the store assigns the id. */
export type RecurrenceDraft = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  byWeekday?: number[]
  byMonthDay?: number
  byNthWeekday?: { nth: number; weekday: number }
  byMonth?: number
  starts: ISODate
  weekStart: WeekStart
}

export type TokenKind = 'date' | 'time' | 'priority' | 'project' | 'tag' | 'recurrence'

export type ParsedToken = {
  kind: TokenKind
  /** Half-open character span in the original input. */
  start: number
  end: number
  /** The exact text that was consumed. */
  text: string
  /** What it was understood to mean, in words, for the preview. */
  label: string
}

export type ParsedInput = {
  /** The input with every recognised token removed and whitespace collapsed. */
  title: string
  due: ISODate | null
  dueTime: string | null
  priority: Priority
  /** The name as typed, without the `#`. Resolution to an id is the app's job. */
  projectName: string | null
  /** Names as typed, without the `@`, in input order, de-duplicated. */
  tagNames: string[]
  recurrence: RecurrenceDraft | null
  tokens: ParsedToken[]
}

export type ParseContext = {
  today: ISODate
  /** Seeds the rule's WKST. Read once here, never again after creation. */
  weekStart: WeekStart
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const NTH: Record<string, number> = {
  first: 1, '1st': 1,
  second: 2, '2nd': 2,
  third: 3, '3rd': 3,
  fourth: 4, '4th': 4,
  last: -1,
}

const NTH_NAMES: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' }

const WEEKDAY_ALT = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|')
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')
const NTH_ALT = Object.keys(NTH).sort((a, b) => b.length - a.length).join('|')

/**
 * Priority ladder. The spec names `!!` and `!!!`; `!` fills in below them so the
 * ramp is guessable from one bang upward. `none` and `low` are set in the detail
 * dialog — typing punctuation to say "this matters slightly less than normal" is
 * not something anyone does.
 */
const BANGS: Record<string, Priority> = { '!': 'medium', '!!': 'high', '!!!': 'urgent' }

/** The next occurrence of `wd` strictly after `from`. Never returns `from` itself. */
function nextWeekday(from: ISODate, wd: number): ISODate {
  const ahead = ((wd - weekday(from)) % 7 + 7) % 7
  return addDays(from, ahead === 0 ? 7 : ahead)
}

function formatHuman(iso: ISODate): string {
  const { y, m, d } = parseISODate(iso)
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** The next date with month `m` and day `d`, at or after `today`, rolling to next year. */
function nextDateOn(today: ISODate, m: number, d: number): ISODate {
  const { y } = parseISODate(today)
  const thisYear = formatISODate(y, m, Math.min(d, daysInMonth(y, m)))
  if (epochDay(thisYear) >= epochDay(today)) return thisYear
  return formatISODate(y + 1, m, Math.min(d, daysInMonth(y + 1, m)))
}

type Draft = {
  due: ISODate | null
  dueTime: string | null
  priority: Priority
  projectName: string | null
  tagNames: string[]
  recurrence: RecurrenceDraft | null
  /**
   * True when the rule named its own anchor — `every monday`, `every last
   * friday`. Such a rule is never re-anchored by a date found later in the
   * line: the user said Monday, so it repeats on Mondays. Only an unanchored
   * rule (`every week`, `every 2 months`) takes its day from the due date.
   */
  recurrenceAnchored: boolean
}

type Matcher = {
  kind: TokenKind
  re: RegExp
  /** Return null to decline the match, leaving the characters for a later matcher. */
  apply: (m: RegExpExecArray, ctx: ParseContext, out: Draft) => string | null
}

/**
 * The order kinds get to claim characters. Recurrence first, so `every monday`
 * is a rule rather than a due date; time before date, so `at 5pm` keeps its
 * digits out of `in 3 days`.
 */
const KIND_ORDER: readonly TokenKind[] = ['recurrence', 'time', 'date', 'priority', 'project', 'tag']

/** Anchor a freshly built rule to the day it starts on. */
function anchor(rule: RecurrenceDraft): RecurrenceDraft {
  const { m, d } = parseISODate(rule.starts)
  if (rule.freq === 'weekly') rule.byWeekday = [weekday(rule.starts)]
  if (rule.freq === 'monthly') rule.byMonthDay = d
  if (rule.freq === 'yearly') {
    rule.byMonth = m
    rule.byMonthDay = d
  }
  return rule
}

/**
 * Matchers run in this order and claim characters exclusively. Recurrence
 * before date, and longer patterns before their own prefixes.
 */
const MATCHERS: Matcher[] = [
  // ---- recurrence -------------------------------------------------------
  {
    // `every last friday`, `every 2nd tuesday` -> monthly by nth weekday.
    kind: 'recurrence',
    re: new RegExp(String.raw`\bevery\s+(${NTH_ALT})\s+(${WEEKDAY_ALT})\b`, 'i'),
    apply: (m, ctx, out) => {
      if (out.recurrence) return null
      const nth = NTH[m[1]!.toLowerCase()]!
      const wd = WEEKDAYS[m[2]!.toLowerCase()]!
      out.recurrence = {
        freq: 'monthly',
        interval: 1,
        byNthWeekday: { nth, weekday: wd },
        starts: out.due ?? ctx.today,
        weekStart: ctx.weekStart,
      }
      out.recurrenceAnchored = true
      return describeRecurrence(out.recurrence)
    },
  },
  {
    // `every other tuesday` -> fortnightly on that weekday.
    kind: 'recurrence',
    re: new RegExp(String.raw`\bevery\s+other\s+(${WEEKDAY_ALT})\b`, 'i'),
    apply: (m, ctx, out) => {
      if (out.recurrence) return null
      const wd = WEEKDAYS[m[1]!.toLowerCase()]!
      out.recurrence = {
        freq: 'weekly',
        interval: 2,
        byWeekday: [wd],
        starts: out.due ?? nextWeekday(ctx.today, wd),
        weekStart: ctx.weekStart,
      }
      out.recurrenceAnchored = true
      return describeRecurrence(out.recurrence)
    },
  },
  {
    kind: 'recurrence',
    re: new RegExp(String.raw`\bevery\s+(?:(\d+)\s+)?(day|days|week|weeks|month|months|year|years)\b`, 'i'),
    apply: (m, ctx, out) => {
      if (out.recurrence) return null
      const interval = m[1] ? Number(m[1]) : 1
      if (interval < 1) return null
      const unit = m[2]!.toLowerCase().replace(/s$/, '')
      const freq =
        unit === 'day' ? 'daily' : unit === 'week' ? 'weekly' : unit === 'month' ? 'monthly' : 'yearly'
      out.recurrence = anchor({
        freq,
        interval,
        starts: out.due ?? ctx.today,
        weekStart: ctx.weekStart,
      })
      return describeRecurrence(out.recurrence)
    },
  },
  {
    // `every monday`, `every mon and thu`, `every tue, thu`.
    kind: 'recurrence',
    re: new RegExp(
      String.raw`\bevery\s+(${WEEKDAY_ALT})(?:\s*(?:,|and|&)\s*(?:${WEEKDAY_ALT}))*\b`,
      'i',
    ),
    apply: (m, ctx, out) => {
      if (out.recurrence) return null
      const days = [...m[0].matchAll(new RegExp(String.raw`\b(${WEEKDAY_ALT})\b`, 'gi'))].map(
        (x) => WEEKDAYS[x[1]!.toLowerCase()]!,
      )
      const unique = [...new Set(days)].sort((a, b) => a - b)
      if (unique.length === 0) return null
      out.recurrence = {
        freq: 'weekly',
        interval: 1,
        byWeekday: unique,
        starts: out.due ?? nextWeekday(ctx.today, unique[0]!),
        weekStart: ctx.weekStart,
      }
      out.recurrenceAnchored = true
      return describeRecurrence(out.recurrence)
    },
  },
  {
    kind: 'recurrence',
    re: /\b(everyday|daily|weekly|monthly|yearly|annually)\b/i,
    apply: (m, ctx, out) => {
      if (out.recurrence) return null
      const word = m[1]!.toLowerCase()
      const freq =
        word === 'everyday' || word === 'daily' ? 'daily'
        : word === 'weekly' ? 'weekly'
        : word === 'monthly' ? 'monthly'
        : 'yearly'
      out.recurrence = anchor({
        freq,
        interval: 1,
        starts: out.due ?? ctx.today,
        weekStart: ctx.weekStart,
      })
      return describeRecurrence(out.recurrence)
    },
  },

  // ---- time -------------------------------------------------------------
  {
    // Time before date, so `at 5pm` does not have its digits eaten by a date
    // matcher. A bare number is never a time: `9` is a quantity.
    kind: 'time',
    re: /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\b(\d{1,2}):(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/i,
    apply: (m, _ctx, out) => {
      if (out.dueTime) return null
      const hRaw = m[1] ?? m[4] ?? m[7]
      const minRaw = m[2] ?? m[5]
      const merid = (m[3] ?? m[6] ?? m[8])?.toLowerCase()
      if (hRaw === undefined) return null
      if (merid === undefined && minRaw === undefined) return null
      let h = Number(hRaw)
      const min = minRaw ? Number(minRaw) : 0
      if (min > 59) return null
      if (merid === 'pm' && h < 12) h += 12
      else if (merid === 'am' && h === 12) h = 0
      if (h > 23) return null
      out.dueTime = `${pad2(h)}:${pad2(min)}`
      // Labelled the way the task row will show it, not as raw 'HH:mm'.
      return formatTimeOfDay(out.dueTime) ?? out.dueTime
    },
  },

  // ---- dates ------------------------------------------------------------
  {
    kind: 'date',
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
    apply: (m, _ctx, out) => {
      if (out.due) return null
      const y = Number(m[1])
      const mo = Number(m[2])
      const d = Number(m[3])
      if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
      out.due = formatISODate(y, mo, d)
      return formatHuman(out.due)
    },
  },
  {
    kind: 'date',
    re: /\b(today|tonight|tomorrow|tmrw)\b/i,
    apply: (m, ctx, out) => {
      if (out.due) return null
      const word = m[1]!.toLowerCase()
      out.due = word === 'today' || word === 'tonight' ? ctx.today : addDays(ctx.today, 1)
      return formatHuman(out.due)
    },
  },
  {
    kind: 'date',
    re: /\bin\s+(\d+)\s+(day|days|week|weeks|month|months)\b/i,
    apply: (m, ctx, out) => {
      if (out.due) return null
      const n = Number(m[1])
      const unit = m[2]!.toLowerCase().replace(/s$/, '')
      out.due =
        unit === 'month' ? addMonths(ctx.today, n) : addDays(ctx.today, unit === 'week' ? n * 7 : n)
      return formatHuman(out.due)
    },
  },
  {
    kind: 'date',
    re: /\bnext\s+week\b/i,
    apply: (_m, ctx, out) => {
      if (out.due) return null
      out.due = addDays(ctx.today, 7)
      return formatHuman(out.due)
    },
  },
  {
    kind: 'date',
    re: /\bnext\s+month\b/i,
    apply: (_m, ctx, out) => {
      if (out.due) return null
      out.due = addMonths(ctx.today, 1)
      return formatHuman(out.due)
    },
  },
  {
    // `next tue` skips the coming one: it means the Tuesday of next week. Bare
    // `tue` means the soonest Tuesday. The preview shows the resolved date
    // either way, which is what settles the ambiguity for the user.
    kind: 'date',
    re: new RegExp(String.raw`\bnext\s+(${WEEKDAY_ALT})\b`, 'i'),
    apply: (m, ctx, out) => {
      if (out.due) return null
      const wd = WEEKDAYS[m[1]!.toLowerCase()]!
      const soonest = nextWeekday(ctx.today, wd)
      const daysLeftThisWeek = 7 - (((weekday(ctx.today) - ctx.weekStart) % 7 + 7) % 7)
      const sameWeek = epochDay(soonest) - epochDay(ctx.today) < daysLeftThisWeek
      out.due = sameWeek ? addDays(soonest, 7) : soonest
      return formatHuman(out.due)
    },
  },
  {
    kind: 'date',
    re: new RegExp(String.raw`\b(?:on\s+)?(\d{1,2})\s+(${MONTH_ALT})\b`, 'i'),
    apply: (m, ctx, out) => {
      if (out.due) return null
      const d = Number(m[1])
      const mo = MONTHS[m[2]!.toLowerCase()]!
      if (d < 1 || d > 31) return null
      out.due = nextDateOn(ctx.today, mo, d)
      return formatHuman(out.due)
    },
  },
  {
    kind: 'date',
    re: new RegExp(String.raw`\b(?:on\s+)?(${MONTH_ALT})\s+(\d{1,2})\b`, 'i'),
    apply: (m, ctx, out) => {
      if (out.due) return null
      const mo = MONTHS[m[1]!.toLowerCase()]!
      const d = Number(m[2])
      if (d < 1 || d > 31) return null
      out.due = nextDateOn(ctx.today, mo, d)
      return formatHuman(out.due)
    },
  },
  {
    kind: 'date',
    re: new RegExp(String.raw`\b(?:on\s+)?(${WEEKDAY_ALT})\b`, 'i'),
    apply: (m, ctx, out) => {
      if (out.due) return null
      out.due = nextWeekday(ctx.today, WEEKDAYS[m[1]!.toLowerCase()]!)
      return formatHuman(out.due)
    },
  },

  // ---- priority, project, tag -------------------------------------------
  {
    kind: 'priority',
    re: /(?:^|\s)(!{1,3})(?=\s|$)/,
    apply: (m, _ctx, out) => {
      if (out.priority !== 'none') return null
      out.priority = BANGS[m[1]!]!
      return out.priority
    },
  },
  {
    kind: 'project',
    re: /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/u,
    apply: (m, _ctx, out) => {
      if (out.projectName) return null
      out.projectName = m[1]!
      return m[1]!
    },
  },
  {
    kind: 'tag',
    re: /(?:^|\s)@([\p{L}\p{N}][\p{L}\p{N}_-]*)/u,
    apply: (m, _ctx, out) => {
      const name = m[1]!
      if (out.tagNames.some((t) => t.toLowerCase() === name.toLowerCase())) return null
      out.tagNames.push(name)
      return name
    },
  },
]

/** Plain language for a rule, used by the preview and (in Phase 5) the editor. */
export function describeRecurrence(rule: RecurrenceDraft): string {
  const every =
    rule.interval === 1 ? 'Every' : rule.interval === 2 ? 'Every other' : `Every ${rule.interval}`
  const plural = rule.interval > 2

  if (rule.freq === 'daily') return `${every} ${plural ? 'days' : 'day'}`

  if (rule.freq === 'weekly') {
    const days = (rule.byWeekday ?? []).map((d) => WEEKDAY_NAMES[d]!)
    const list =
      days.length === 0 ? ''
      : days.length === 1 ? ` on ${days[0]}`
      : ` on ${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`
    return `${every} ${plural ? 'weeks' : 'week'}${list}`
  }

  if (rule.freq === 'monthly') {
    const unit = plural ? 'months' : 'month'
    if (rule.byNthWeekday) {
      const { nth, weekday: wd } = rule.byNthWeekday
      return `${every} ${unit} on the ${NTH_NAMES[nth] ?? nth} ${WEEKDAY_NAMES[wd]}`
    }
    return `${every} ${unit}${rule.byMonthDay ? ` on day ${rule.byMonthDay}` : ''}`
  }

  const on =
    rule.byMonth && rule.byMonthDay ? ` on ${rule.byMonthDay} ${MONTH_NAMES[rule.byMonth - 1]}` : ''
  return `${every} ${plural ? 'years' : 'year'}${on}`
}

/**
 * Move an *implied* rule's anchor to `date`. Only ever called on a rule that
 * did not name its own day, so there is nothing here to preserve.
 */
function reanchor(rule: RecurrenceDraft, date: ISODate): RecurrenceDraft {
  return anchor({ ...rule, starts: date })
}

/**
 * Parse a quick-add line.
 *
 * Every token found is removed from the title and reported with its span. A
 * word that looks like a token but sits inside another match — the `monday` in
 * `every monday` — is never double-counted, because matchers claim characters
 * exclusively, and whole kinds are resolved in the order above: a recurrence
 * claims its characters before any date matcher gets to look at them.
 *
 * Within a kind, the match that starts *earliest in the input* wins, not the
 * one whose matcher happens to sit first in the table. Otherwise
 * `every monday every 3 days` would be read as a daily rule, and
 * `monday tomorrow` would be due tomorrow — in both cases the second thing the
 * user typed would silently beat the first. Ties at the same position fall back
 * to matcher order, which is arranged specific-before-general.
 */
export function parseQuickAdd(input: string, ctx: ParseContext): ParsedInput {
  const claimed = new Array<boolean>(input.length).fill(false)
  const tokens: ParsedToken[] = []
  const draft: Draft = {
    due: null,
    dueTime: null,
    priority: 'none',
    projectName: null,
    tagNames: [],
    recurrence: null,
    recurrenceAnchored: false,
  }

  const free = (start: number, end: number): boolean => {
    for (let i = start; i < end; i += 1) if (claimed[i]) return false
    return true
  }

  // Matches a matcher declined (an impossible date, a duplicate tag) so the
  // next pass looks past them instead of offering the same one forever.
  const declined = new Set<string>()

  for (const kind of KIND_ORDER) {
    const group = MATCHERS.map((matcher, index) => ({ matcher, index })).filter(
      (entry) => entry.matcher.kind === kind,
    )
    // Tags may appear more than once; everything else takes one value.
    const repeatable = kind === 'tag'

    for (;;) {
      let best: { index: number; m: RegExpExecArray; start: number; end: number } | null = null

      for (const { matcher, index } of group) {
        const re = new RegExp(matcher.re.source, `${matcher.re.flags.replace('g', '')}g`)
        let m: RegExpExecArray | null
        while ((m = re.exec(input)) !== null) {
          // A leading `(?:^|\s)` swallows the separator; keep it out of the span.
          const lead = /^\s/.test(m[0]) ? 1 : 0
          const start = m.index + lead
          const end = m.index + m[0].length
          if (end > start && free(start, end) && !declined.has(`${index}:${start}:${end}`)) {
            if (best === null || start < best.start || (start === best.start && index < best.index)) {
              best = { index, m, start, end }
            }
            break
          }
          if (re.lastIndex <= m.index) re.lastIndex = m.index + 1
        }
      }

      if (best === null) break

      const matcher = MATCHERS[best.index]!
      const label = matcher.apply(best.m, ctx, draft)
      if (label === null) {
        declined.add(`${best.index}:${best.start}:${best.end}`)
        continue
      }

      for (let i = best.start; i < best.end; i += 1) claimed[i] = true
      tokens.push({
        kind,
        start: best.start,
        end: best.end,
        text: input.slice(best.start, best.end),
        label,
      })
      if (!repeatable) break
    }
  }

  // A recurrence anchored to `today` before a later matcher found a due date
  // has to re-anchor, or `every week on friday` would start from the wrong day.
  if (draft.recurrence && !draft.recurrenceAnchored && draft.due && draft.recurrence.starts !== draft.due) {
    draft.recurrence = reanchor(draft.recurrence, draft.due)
    const token = tokens.find((t) => t.kind === 'recurrence')
    if (token) token.label = describeRecurrence(draft.recurrence)
  }

  let title = ''
  for (let i = 0; i < input.length; i += 1) if (!claimed[i]) title += input[i]

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    due: draft.due,
    dueTime: draft.dueTime,
    priority: draft.priority,
    projectName: draft.projectName,
    tagNames: draft.tagNames,
    recurrence: draft.recurrence,
    tokens: tokens.sort((a, b) => a.start - b.start),
  }
}

/** True when the line carries nothing but tokens — nothing to name the task. */
export function isTitleEmpty(parsed: ParsedInput): boolean {
  return parsed.title.length === 0
}
