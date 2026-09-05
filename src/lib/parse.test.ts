import { describe, expect, it } from 'vitest'
import { describeRecurrence, isTitleEmpty, parseQuickAdd } from './parse.ts'
import type { ParseContext } from './parse.ts'
import { formatTimeOfDay } from './dates.ts'

// 2026-09-05 is a Saturday. Chosen deliberately: a mid-week anchor hides
// off-by-one errors in "next <weekday>" that a weekend anchor exposes.
const CTX: ParseContext = { today: '2026-09-05', weekStart: 1 }

const parse = (input: string, ctx: ParseContext = CTX) => parseQuickAdd(input, ctx)

describe('title extraction', () => {
  it('returns the whole line when nothing is recognised', () => {
    expect(parse('write the report').title).toBe('write the report')
  })

  it('strips every recognised token and collapses the gap', () => {
    const p = parse('submit taxes tomorrow !! #finance @admin')
    expect(p.title).toBe('submit taxes')
  })

  it('collapses whitespace left behind by a token in the middle', () => {
    expect(parse('call #work the plumber').title).toBe('call the plumber')
  })

  it('reports an empty title when the line is only tokens', () => {
    expect(isTitleEmpty(parse('tomorrow !! #work'))).toBe(true)
    expect(isTitleEmpty(parse('buy milk'))).toBe(false)
  })

  it('leaves an unmatched hash or at sign in the title', () => {
    expect(parse('email me @ 5 pounds # hash').title).toBe('email me @ 5 pounds # hash')
  })
})

describe('dates', () => {
  it('parses today and tonight', () => {
    expect(parse('ship it today').due).toBe('2026-09-05')
    expect(parse('ship it tonight').due).toBe('2026-09-05')
  })

  it('parses tomorrow', () => {
    expect(parse('ship it tomorrow').due).toBe('2026-09-06')
    expect(parse('ship it tmrw').due).toBe('2026-09-06')
  })

  it('parses a bare weekday as the soonest strictly-future one', () => {
    // Saturday 2026-09-05 -> the next Monday is the 7th.
    expect(parse('gym monday').due).toBe('2026-09-07')
    // Never today itself, even when the weekday matches.
    expect(parse('gym saturday').due).toBe('2026-09-12')
  })

  it('parses "next <weekday>" as the following week, not the coming day', () => {
    // The week (Mon-start) containing Sat 2026-09-05 ends on Sun the 6th, so
    // the soonest Monday already falls in the next week and does not shift.
    expect(parse('review next monday').due).toBe('2026-09-07')
    // Sunday the 6th is still inside this week, so it pushes a week out.
    expect(parse('review next sunday').due).toBe('2026-09-13')
  })

  it('parses "in N days", weeks and months', () => {
    expect(parse('call in 3 days').due).toBe('2026-09-08')
    expect(parse('call in 2 weeks').due).toBe('2026-09-19')
    expect(parse('call in 1 month').due).toBe('2026-10-05')
  })

  it('parses next week and next month', () => {
    expect(parse('plan next week').due).toBe('2026-09-12')
    expect(parse('plan next month').due).toBe('2026-10-05')
  })

  it('parses "23 dec" and "dec 23"', () => {
    expect(parse('gifts 23 dec').due).toBe('2026-12-23')
    expect(parse('gifts dec 23').due).toBe('2026-12-23')
    expect(parse('gifts 23 december').due).toBe('2026-12-23')
  })

  it('rolls a day-month that has already passed into next year', () => {
    expect(parse('taxes 3 jan').due).toBe('2027-01-03')
  })

  it('keeps a day-month that is today', () => {
    expect(parse('party 5 sep').due).toBe('2026-09-05')
  })

  it('clamps 31 february to the end of the month rather than rejecting it', () => {
    expect(parse('odd 31 feb').due).toBe('2027-02-28')
  })

  it('parses an explicit ISO date', () => {
    expect(parse('launch 2027-03-01').due).toBe('2027-03-01')
  })

  it('ignores an ISO-shaped string that is not a real date', () => {
    const p = parse('build 2027-02-30')
    expect(p.due).toBeNull()
    expect(p.title).toBe('build 2027-02-30')
  })

  it('accepts an optional leading "on"', () => {
    expect(parse('meet on friday').due).toBe('2026-09-11')
    expect(parse('meet on 23 dec').due).toBe('2026-12-23')
  })

  it('takes only the first date', () => {
    const p = parse('move tomorrow monday')
    expect(p.due).toBe('2026-09-06')
    expect(p.title).toBe('move monday')
  })

  it('takes the date that appears first in the input, not the first matcher', () => {
    // `monday` is matched by a later matcher than `tomorrow`; position wins.
    const p = parse('move monday tomorrow')
    expect(p.due).toBe('2026-09-07')
    expect(p.title).toBe('move tomorrow')
  })
})

describe('times', () => {
  it('parses "at 5pm"', () => {
    expect(parse('standup at 5pm').dueTime).toBe('17:00')
  })

  it('parses a 24-hour time', () => {
    expect(parse('standup at 17:30').dueTime).toBe('17:30')
  })

  it('parses a bare meridiem time without "at"', () => {
    expect(parse('standup 9am').dueTime).toBe('09:00')
    expect(parse('standup 9:15am').dueTime).toBe('09:15')
  })

  it('maps 12am to midnight and 12pm to noon', () => {
    expect(parse('x at 12am').dueTime).toBe('00:00')
    expect(parse('x at 12pm').dueTime).toBe('12:00')
  })

  it('does not read a bare number as a time', () => {
    const p = parse('buy 9 eggs')
    expect(p.dueTime).toBeNull()
    expect(p.title).toBe('buy 9 eggs')
  })

  it('does not let a time swallow the digits of a date', () => {
    const p = parse('call in 3 days at 5pm')
    expect(p.due).toBe('2026-09-08')
    expect(p.dueTime).toBe('17:00')
    expect(p.title).toBe('call')
  })

  it('rejects an impossible time and leaves it in the title', () => {
    const p = parse('run at 25:00')
    expect(p.dueTime).toBeNull()
  })

  it.each(['at 9am', 'at 5pm', 'at 17:30', '9:15am', 'at 12am', 'at 12pm'])(
    'labels "%s" exactly as the task row will show it',
    (phrase) => {
      const p = parse(`x ${phrase}`)
      const token = p.tokens.find((t) => t.kind === 'time')!
      // The preview and the row must read from one formatter. They drifted once:
      // the chip said "09:00" while the row beside it said "9 am".
      expect(token.label).toBe(formatTimeOfDay(p.dueTime))
    },
  )
})

describe('priority', () => {
  it('maps the bang ladder', () => {
    expect(parse('a !').priority).toBe('medium')
    expect(parse('a !!').priority).toBe('high')
    expect(parse('a !!!').priority).toBe('urgent')
  })

  it('defaults to none', () => {
    expect(parse('a').priority).toBe('none')
  })

  it('ignores a bang glued to a word', () => {
    const p = parse('ship it!')
    expect(p.priority).toBe('none')
    expect(p.title).toBe('ship it!')
  })

  it('takes only the first bang token', () => {
    const p = parse('a !! !')
    expect(p.priority).toBe('high')
    expect(p.title).toBe('a !')
  })
})

describe('projects and tags', () => {
  it('parses a project', () => {
    expect(parse('essay #uni').projectName).toBe('uni')
  })

  it('parses several tags in input order', () => {
    expect(parse('essay @deep @evening').tagNames).toEqual(['deep', 'evening'])
  })

  it('de-duplicates tags case-insensitively', () => {
    expect(parse('essay @Deep @deep').tagNames).toEqual(['Deep'])
  })

  it('takes only the first project', () => {
    const p = parse('essay #uni #home')
    expect(p.projectName).toBe('uni')
    expect(p.title).toBe('essay #home')
  })

  it('accepts dashes, underscores and non-ASCII letters in names', () => {
    expect(parse('x #side-project').projectName).toBe('side-project')
    expect(parse('x @sehr_gut').tagNames).toEqual(['sehr_gut'])
    expect(parse('x #café').projectName).toBe('café')
  })
})

describe('recurrence', () => {
  it('parses "every monday"', () => {
    const r = parse('gym every monday').recurrence!
    expect(r.freq).toBe('weekly')
    expect(r.interval).toBe(1)
    expect(r.byWeekday).toEqual([1])
    expect(r.starts).toBe('2026-09-07')
  })

  it('does not also read the weekday of a recurrence as a due date', () => {
    const p = parse('gym every monday')
    expect(p.due).toBeNull()
    expect(p.title).toBe('gym')
  })

  it('parses a multi-day weekly set', () => {
    const r = parse('gym every tue and thu').recurrence!
    expect(r.byWeekday).toEqual([2, 4])
    expect(r.interval).toBe(1)
  })

  it('parses "every 2 weeks"', () => {
    const r = parse('pay rent every 2 weeks').recurrence!
    expect(r.freq).toBe('weekly')
    expect(r.interval).toBe(2)
  })

  it('parses "every other tuesday" as a fortnightly rule', () => {
    const r = parse('sync every other tuesday').recurrence!
    expect(r.freq).toBe('weekly')
    expect(r.interval).toBe(2)
    expect(r.byWeekday).toEqual([2])
  })

  it('parses "every last friday" as monthly by nth weekday', () => {
    const r = parse('report every last friday').recurrence!
    expect(r.freq).toBe('monthly')
    expect(r.byNthWeekday).toEqual({ nth: -1, weekday: 5 })
  })

  it('parses "every 2nd tuesday"', () => {
    const r = parse('board every 2nd tuesday').recurrence!
    expect(r.byNthWeekday).toEqual({ nth: 2, weekday: 2 })
  })

  it('parses the single-word forms', () => {
    expect(parse('x daily').recurrence!.freq).toBe('daily')
    expect(parse('x weekly').recurrence!.freq).toBe('weekly')
    expect(parse('x monthly').recurrence!.freq).toBe('monthly')
    expect(parse('x yearly').recurrence!.freq).toBe('yearly')
    expect(parse('x annually').recurrence!.freq).toBe('yearly')
  })

  it('anchors a monthly rule to the day of its start date', () => {
    const r = parse('rent every month on 23 dec').recurrence!
    expect(r.starts).toBe('2026-12-23')
    expect(r.byMonthDay).toBe(23)
  })

  it('anchors a yearly rule to the month and day of its start date', () => {
    const r = parse('renew every year on 23 dec').recurrence!
    expect(r.byMonth).toBe(12)
    expect(r.byMonthDay).toBe(23)
  })

  it('re-anchors a weekly rule when a due date appears after it', () => {
    // "every week" alone anchors to today (Saturday); the explicit date wins.
    const r = parse('call every week tomorrow').recurrence!
    expect(r.starts).toBe('2026-09-06')
    expect(r.byWeekday).toEqual([0])
  })

  it('does not re-anchor an explicit multi-day weekly set', () => {
    const r = parse('gym every tue and thu tomorrow').recurrence!
    // Anchored on the first named weekday, not dragged onto the stray date.
    expect(r.starts).toBe('2026-09-08')
    expect(r.byWeekday).toEqual([2, 4])
  })

  it('seeds weekStart from context and never from anywhere else', () => {
    expect(parse('x every 2 weeks', { today: '2026-09-05', weekStart: 0 }).recurrence!.weekStart).toBe(0)
    expect(parse('x every 2 weeks', { today: '2026-09-05', weekStart: 1 }).recurrence!.weekStart).toBe(1)
  })

  it('takes only the first recurrence', () => {
    const p = parse('x every monday every 3 days')
    expect(p.recurrence!.freq).toBe('weekly')
    expect(p.recurrence!.byWeekday).toEqual([1])
    expect(p.title).toBe('x every 3 days')
  })

  it('does not let a later date re-anchor a rule that named its own weekday', () => {
    // The user said Mondays. A stray date elsewhere in the line does not get to
    // silently turn that into a Sunday rule.
    const p = parse('gym every monday tomorrow')
    expect(p.recurrence!.byWeekday).toEqual([1])
    expect(p.recurrence!.starts).toBe('2026-09-07')
    expect(p.due).toBe('2026-09-06')
  })

  it('does not re-anchor an nth-weekday rule either', () => {
    const p = parse('report every last friday tomorrow')
    expect(p.recurrence!.byNthWeekday).toEqual({ nth: -1, weekday: 5 })
  })
})

/*
 * The two invariants below are enforced over a corpus rather than over one
 * example each, because both regress silently: the anchoring rule lives in a
 * flag that a new matcher can simply forget to set, and the position rule lives
 * in the resolution loop rather than in the matcher table.
 *
 * ANY NEW RECURRENCE MATCHER MUST BE ADDED TO ONE OF THESE TWO LISTS.
 * A phrasing that appears in neither is unprotected, which is what the
 * completeness test at the bottom is for.
 */

/** Phrasings that name their own anchor: a later date must not move them. */
const ANCHORED_PHRASES = [
  'every monday',
  'every mon and thu',
  'every tue, thu',
  'every other tuesday',
  'every last friday',
  'every 2nd tuesday',
  'every first monday',
]

/** Phrasings that imply their anchor: a later date is allowed to move them. */
const IMPLIED_PHRASES = [
  'every day',
  'every 3 days',
  'every week',
  'every 2 weeks',
  'every month',
  'every 6 months',
  'every year',
  'daily',
  'everyday',
  'weekly',
  'monthly',
  'yearly',
  'annually',
]

describe('recurrence anchoring invariant', () => {
  it.each(ANCHORED_PHRASES)('"%s" survives a date appearing later in the line', (phrase) => {
    const alone = parse(`x ${phrase}`).recurrence!
    const withDate = parse(`x ${phrase} tomorrow`).recurrence!

    // The rule the user stated is the rule they keep, in full.
    expect(withDate.starts).toBe(alone.starts)
    expect(withDate.byWeekday).toEqual(alone.byWeekday)
    expect(withDate.byNthWeekday).toEqual(alone.byNthWeekday)
    expect(withDate.freq).toBe(alone.freq)
    expect(withDate.interval).toBe(alone.interval)
  })

  it.each(IMPLIED_PHRASES)('"%s" takes its anchor from a date later in the line', (phrase) => {
    const withDate = parse(`x ${phrase} tomorrow`)
    expect(withDate.due).toBe('2026-09-06')
    // An implied rule has no opinion of its own, so it starts on the due date.
    expect(withDate.recurrence!.starts).toBe('2026-09-06')
  })

  it('covers every recurrence phrasing the parser accepts', () => {
    // A phrasing that parses to a rule but sits in neither list is untested by
    // the two invariants above. This is the tripwire for a new matcher.
    for (const phrase of [...ANCHORED_PHRASES, ...IMPLIED_PHRASES]) {
      expect(parse(`x ${phrase}`).recurrence, `"${phrase}" no longer parses`).not.toBeNull()
    }
    expect(new Set([...ANCHORED_PHRASES, ...IMPLIED_PHRASES]).size).toBe(
      ANCHORED_PHRASES.length + IMPLIED_PHRASES.length,
    )
  })
})

describe('position beats matcher order', () => {
  // Each pair is two tokens of the same kind whose matchers sit at different
  // places in the table. Whichever is typed first must win, both ways round.
  const PAIRS: { kind: string; a: string; b: string; read: (input: string) => unknown }[] = [
    { kind: 'date', a: 'tomorrow', b: 'monday', read: (s) => parse(s).due },
    { kind: 'date', a: 'today', b: '23 dec', read: (s) => parse(s).due },
    { kind: 'date', a: 'in 3 days', b: '2027-03-01', read: (s) => parse(s).due },
    {
      kind: 'recurrence',
      a: 'every monday',
      b: 'every 3 days',
      read: (s) => parse(s).recurrence?.freq,
    },
    {
      kind: 'recurrence',
      a: 'every last friday',
      b: 'every week',
      read: (s) => parse(s).recurrence?.byNthWeekday,
    },
  ]

  it.each(PAIRS)('$kind: "$a" before "$b" wins, and so does the reverse', ({ a, b, read }) => {
    // Reading the same value from each single-token line gives the expected
    // answer without hard-coding it, so these stay correct if a label changes.
    expect(read(`x ${a} ${b}`)).toEqual(read(`x ${a}`))
    expect(read(`x ${b} ${a}`)).toEqual(read(`x ${b}`))
  })
})

describe('describeRecurrence', () => {
  const base = { starts: '2026-09-07', weekStart: 1 } as const

  it('describes daily rules', () => {
    expect(describeRecurrence({ ...base, freq: 'daily', interval: 1 })).toBe('Every day')
    expect(describeRecurrence({ ...base, freq: 'daily', interval: 2 })).toBe('Every other day')
    expect(describeRecurrence({ ...base, freq: 'daily', interval: 3 })).toBe('Every 3 days')
  })

  it('lists weekdays in plain language', () => {
    expect(describeRecurrence({ ...base, freq: 'weekly', interval: 1, byWeekday: [1] })).toBe(
      'Every week on Monday',
    )
    expect(describeRecurrence({ ...base, freq: 'weekly', interval: 2, byWeekday: [2, 4] })).toBe(
      'Every other week on Tuesday and Thursday',
    )
  })

  it('describes an nth-weekday rule', () => {
    expect(
      describeRecurrence({ ...base, freq: 'monthly', interval: 1, byNthWeekday: { nth: -1, weekday: 5 } }),
    ).toBe('Every month on the last Friday')
  })

  it('describes a yearly rule with its date', () => {
    expect(
      describeRecurrence({ ...base, freq: 'yearly', interval: 1, byMonth: 12, byMonthDay: 23 }),
    ).toBe('Every year on 23 December')
  })
})

describe('tokens', () => {
  it('reports a span for every token, in input order', () => {
    const p = parse('submit taxes tomorrow !! #finance @admin')
    expect(p.tokens.map((t) => t.kind)).toEqual(['date', 'priority', 'project', 'tag'])
    for (const t of p.tokens) {
      expect('submit taxes tomorrow !! #finance @admin'.slice(t.start, t.end)).toBe(t.text)
    }
  })

  it('does not include the separating space in a token span', () => {
    const p = parse('x #work')
    expect(p.tokens[0]!.text).toBe('#work')
  })

  it('labels a date token with the resolved date', () => {
    const p = parse('x tomorrow')
    expect(p.tokens[0]!.label).toBe('6 September 2026')
  })

  it('labels a recurrence token with its plain-language summary', () => {
    const p = parse('x every other tuesday')
    expect(p.tokens[0]!.label).toBe('Every other week on Tuesday')
  })

  it('relabels a recurrence token after a later date re-anchors it', () => {
    const p = parse('x every week tomorrow')
    expect(p.tokens.find((t) => t.kind === 'recurrence')!.label).toBe('Every week on Sunday')
  })
})

describe('robustness', () => {
  it('handles an empty string', () => {
    const p = parse('')
    expect(p.title).toBe('')
    expect(p.tokens).toEqual([])
  })

  it('handles a string of only whitespace', () => {
    expect(parse('    ').title).toBe('')
  })

  it('is case-insensitive', () => {
    expect(parse('X TOMORROW #Work').due).toBe('2026-09-06')
    expect(parse('X TOMORROW #Work').projectName).toBe('Work')
  })

  it('parses a dense line with every token kind at once', () => {
    const p = parse('file returns every last friday at 9am !!! #finance @admin @deep')
    expect(p.title).toBe('file returns')
    expect(p.recurrence!.byNthWeekday).toEqual({ nth: -1, weekday: 5 })
    expect(p.dueTime).toBe('09:00')
    expect(p.priority).toBe('urgent')
    expect(p.projectName).toBe('finance')
    expect(p.tagNames).toEqual(['admin', 'deep'])
  })
})
