import { describe, expect, it } from 'vitest'
import {
  MAX_WINDOW_DAYS,
  agendaDays,
  dayDetail,
  dayHeading,
  dayLoadLabel,
  entriesBetween,
  firstOfMonth,
  monthGrid,
  monthTitle,
  stepDate,
  weekdayHeadings,
} from './calendar.ts'
import { defaultState } from './storage.ts'
import type { ISODate, Recurrence, State, Task } from './types.ts'

/** 2026-09-06 is a Sunday; 2026-09-07 is a Monday. */
const TODAY: ISODate = '2026-09-06'

const task = (over: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
  notes: '',
  done: false,
  completedAt: null,
  due: null,
  dueTime: null,
  priority: 'none',
  projectId: null,
  tagIds: [],
  parentId: null,
  order: 0,
  recurrenceId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
})

const rule = (over: Partial<Recurrence> & Pick<Recurrence, 'id' | 'freq' | 'starts'>): Recurrence => ({
  interval: 1,
  weekStart: 1,
  ends: { type: 'never' },
  exceptions: [],
  ...over,
})

const stateWith = (tasks: Task[], recurrences: Recurrence[] = []): State => ({
  ...defaultState(),
  tasks,
  recurrences,
})

describe('entriesBetween', () => {
  it('places a plain task on its due date', () => {
    const state = stateWith([task({ id: 't1', title: 'Essay', due: '2026-09-09' })])
    const days = entriesBetween(state, '2026-09-01', '2026-09-30', TODAY)

    expect([...days.keys()]).toEqual(['2026-09-09'])
    expect(days.get('2026-09-09')![0]).toMatchObject({
      taskId: 't1', title: 'Essay', repeats: false, status: 'pending', actionable: true,
    })
  })

  it('leaves subtasks off the calendar entirely', () => {
    const state = stateWith([
      task({ id: 't1', title: 'Move house', due: '2026-09-09' }),
      task({ id: 't2', title: 'Book van', due: '2026-09-09', parentId: 't1' }),
    ])
    expect(entriesBetween(state, '2026-09-01', '2026-09-30', TODAY).get('2026-09-09')).toHaveLength(1)
  })

  /*
   * The whole reason this module exists. A weekly task is one row in
   * `state.tasks` sitting on one date; the other five occurrences on a month
   * grid are not tasks and can only come out of the rule.
   */
  it('draws every occurrence of a rule, not just the one the task is due on', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'r1' })],
      [rule({ id: 'r1', freq: 'weekly', starts: '2026-09-07', byWeekday: [1] })],
    )
    const days = entriesBetween(state, '2026-09-01', '2026-09-30', TODAY)

    expect([...days.keys()].sort()).toEqual([
      '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28',
    ])
    expect(days.get('2026-09-14')![0]).toMatchObject({ title: 'Standup', repeats: true })
  })

  it('marks only the occurrence the task is sitting on as actionable', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'r1' })],
      [rule({ id: 'r1', freq: 'weekly', starts: '2026-09-07', byWeekday: [1] })],
    )
    const days = entriesBetween(state, '2026-09-01', '2026-09-30', TODAY)

    expect(days.get('2026-09-07')![0]!.actionable).toBe(true)
    expect(days.get('2026-09-14')![0]!.actionable).toBe(false)
  })

  it('never draws a repeating task twice on its due date', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'r1' })],
      [rule({ id: 'r1', freq: 'weekly', starts: '2026-09-07', byWeekday: [1] })],
    )
    expect(entriesBetween(state, '2026-09-07', '2026-09-07', TODAY).get('2026-09-07')).toHaveLength(1)
  })

  it('falls back to the due date when the rule has gone missing', () => {
    const state = stateWith([
      task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'gone' }),
    ])
    expect(entriesBetween(state, '2026-09-01', '2026-09-30', TODAY).get('2026-09-07')).toHaveLength(1)
  })

  it('carries an occurrence status through, and moves it to where it was moved to', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Review', due: '2026-09-21', recurrenceId: 'r1' })],
      [
        rule({
          id: 'r1',
          freq: 'weekly',
          starts: '2026-09-07',
          byWeekday: [1],
          exceptions: [
            { date: '2026-09-07', kind: 'completed', completedAt: '2026-09-07T09:00:00.000Z' },
            { date: '2026-09-14', kind: 'moved', movedTo: '2026-09-16' },
          ],
        }),
      ],
    )
    const days = entriesBetween(state, '2026-09-01', '2026-09-30', TODAY)

    expect(days.get('2026-09-07')![0]!.status).toBe('completed')
    expect(days.get('2026-09-14')).toBeUndefined()
    expect(days.get('2026-09-16')![0]).toMatchObject({ status: 'moved', date: '2026-09-16' })
  })

  it('calls a past pending occurrence overdue and a completed one not', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'r1' })],
      [
        rule({
          id: 'r1',
          freq: 'daily',
          starts: '2026-09-01',
          exceptions: [{ date: '2026-09-02', kind: 'completed', completedAt: 'x' }],
        }),
      ],
    )
    const days = entriesBetween(state, '2026-09-01', '2026-09-08', TODAY)

    expect(days.get('2026-09-01')![0]!.overdue).toBe(true)
    expect(days.get('2026-09-02')![0]!.overdue).toBe(false)
    expect(days.get('2026-09-08')![0]!.overdue).toBe(false)
  })

  it('sorts a day by time first, then priority, then title', () => {
    const state = stateWith([
      task({ id: 'a', title: 'Zebra', due: '2026-09-09' }),
      task({ id: 'b', title: 'Apple', due: '2026-09-09', priority: 'urgent' }),
      task({ id: 'c', title: 'Late', due: '2026-09-09', dueTime: '17:00' }),
      task({ id: 'd', title: 'Early', due: '2026-09-09', dueTime: '09:00' }),
    ])
    const day = entriesBetween(state, '2026-09-09', '2026-09-09', TODAY).get('2026-09-09')!
    expect(day.map((e) => e.title)).toEqual(['Early', 'Late', 'Apple', 'Zebra'])
  })

  it('refuses a window longer than the cap rather than walking every rule for a year', () => {
    const state = stateWith([])
    expect(() => entriesBetween(state, '2026-01-01', '2030-01-01', TODAY)).toThrow(
      new RegExp(String(MAX_WINDOW_DAYS)),
    )
  })

  it('refuses a backwards window', () => {
    expect(() => entriesBetween(stateWith([]), '2026-09-10', '2026-09-01', TODAY)).toThrow(/before/)
  })

  /*
   * A rule that never ends is the case the Phase 1 invariant exists for: the
   * answer must be bounded by the window, not by the rule.
   */
  it('bounds an endless daily rule by the window', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Water plants', due: '2026-09-06', recurrenceId: 'r1' })],
      [rule({ id: 'r1', freq: 'daily', starts: '2020-01-01' })],
    )
    const days = entriesBetween(state, '2026-09-01', '2026-09-30', TODAY)
    expect(days.size).toBe(30)
  })
})

describe('attribution across a "this and all future" split', () => {
  /*
   * `splitSeries` ends the original the day before the new rule starts and
   * moves the task onto the new one, so the original is left with no task
   * pointing at it. It is kept only because it carries the record of what was
   * actually done — and drawing that record is what this view is for.
   */
  const split = (): State =>
    stateWith(
      [task({ id: 't1', title: 'Review', due: '2026-09-21', recurrenceId: 'r2' })],
      [
        rule({
          id: 'r1',
          freq: 'weekly',
          starts: '2026-09-07',
          byWeekday: [1],
          ends: { type: 'until', date: '2026-09-13' },
          exceptions: [
            { date: '2026-09-07', kind: 'completed', completedAt: '2026-09-07T09:00:00.000Z' },
          ],
        }),
        rule({ id: 'r2', freq: 'weekly', starts: '2026-09-14', byWeekday: [1] }),
      ],
    )

  it('titles a completion recorded before the split', () => {
    const days = entriesBetween(split(), '2026-09-01', '2026-09-30', TODAY)
    expect(days.get('2026-09-07')![0]).toMatchObject({
      title: 'Review', status: 'completed', actionable: false,
    })
  })

  it('leaves the orphaned rule\'s pending dates off: nothing can act on them', () => {
    const state = split()
    state.recurrences[0]!.starts = '2026-08-24'
    const days = entriesBetween(state, '2026-08-24', '2026-09-30', TODAY)
    // 24 and 31 August are pending dates of the dead half and are not drawn;
    // 7 September is its one completion and is.
    expect([...days.keys()].sort()).toEqual([
      '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28',
    ])
  })

  it('links nothing when two rules start on the same day', () => {
    const state = split()
    state.recurrences.push(rule({ id: 'r3', freq: 'daily', starts: '2026-09-14' }))
    const days = entriesBetween(state, '2026-09-01', '2026-09-30', TODAY)
    expect(days.get('2026-09-07')).toBeUndefined()
  })
})

describe('monthGrid', () => {
  it('is always six whole weeks, whatever the month', () => {
    for (const month of ['2026-02-01', '2026-09-01', '2027-05-01']) {
      const grid = monthGrid(stateWith([]), month, TODAY, 1)
      expect(grid.weeks).toHaveLength(6)
      expect(grid.weeks.every((w) => w.days.length === 7)).toBe(true)
    }
  })

  it('starts the grid on the week containing the first, in the user\'s week', () => {
    expect(monthGrid(stateWith([]), '2026-09-01', TODAY, 1).weeks[0]!.days[0]!.date).toBe('2026-08-31')
    expect(monthGrid(stateWith([]), '2026-09-01', TODAY, 0).weeks[0]!.days[0]!.date).toBe('2026-08-30')
  })

  it('marks borrowed days as out of month, and today as today', () => {
    const grid = monthGrid(stateWith([]), '2026-09-01', TODAY, 1)
    const all = grid.weeks.flatMap((w) => w.days)

    expect(all.find((d) => d.date === '2026-08-31')!.inMonth).toBe(false)
    expect(all.find((d) => d.date === '2026-09-01')!.inMonth).toBe(true)
    expect(all.filter((d) => d.isToday).map((d) => d.date)).toEqual([TODAY])
  })

  it('counts a day\'s outstanding and overdue load, ignoring what is finished', () => {
    const state = stateWith([
      task({ id: 'a', title: 'One', due: '2026-09-02' }),
      task({ id: 'b', title: 'Two', due: '2026-09-02' }),
      task({ id: 'c', title: 'Done', due: '2026-09-02', done: true, completedAt: 'x' }),
    ])
    const day = monthGrid(state, '2026-09-01', TODAY, 1)
      .weeks.flatMap((w) => w.days)
      .find((d) => d.date === '2026-09-02')!

    expect(day.entries).toHaveLength(3)
    expect(day.pending).toBe(2)
    expect(day.overdue).toBe(2)
  })

  it('titles the month and heads the columns in week-start order', () => {
    expect(monthGrid(stateWith([]), '2026-09-14', TODAY, 1).title).toBe('September 2026')
    expect(weekdayHeadings(1).map((w) => w.short)).toEqual(
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    )
    expect(weekdayHeadings(0)[0]!.long).toBe('Sunday')
  })
})

describe('agenda', () => {
  it('emits every day in the window, empty ones included', () => {
    const days = agendaDays(stateWith([]), '2026-09-01', '2026-09-07', TODAY)
    expect(days.map((d) => d.date)).toEqual([
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      '2026-09-05', '2026-09-06', '2026-09-07',
    ])
    expect(days.every((d) => d.entries.length === 0)).toBe(true)
  })

  it('describes a day in words for the readout', () => {
    const state = stateWith([
      task({ id: 'a', title: 'One', due: '2026-09-02' }),
      task({ id: 'b', title: 'Done', due: '2026-09-02', done: true, completedAt: 'x' }),
    ])
    const [day] = agendaDays(state, '2026-09-02', '2026-09-02', TODAY)
    expect(dayLoadLabel(day!)).toBe('1 task, 1 overdue, 1 done')
    expect(dayLoadLabel(agendaDays(state, '2026-09-03', '2026-09-03', TODAY)[0]!))
      .toBe('Nothing scheduled')
  })

  it('names a day relative to today, then absolutely', () => {
    expect(dayHeading(TODAY, TODAY)).toBe('Today · Sunday 6 September')
    expect(dayHeading('2026-09-07', TODAY)).toBe('Tomorrow · Monday 7 September')
    expect(dayHeading('2026-09-05', TODAY)).toBe('Yesterday · Saturday 5 September')
    expect(dayHeading('2026-09-20', TODAY)).toBe('Sunday 20 September')
    expect(dayHeading('2027-01-04', TODAY)).toBe('Monday 4 January 2027')
  })
})

describe('dayDetail', () => {
  it('answers for one day without building a grid', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'r1' })],
      [rule({ id: 'r1', freq: 'daily', starts: '2026-09-01' })],
    )
    const day = dayDetail(state, '2026-09-25', TODAY)
    expect(day.entries.map((e) => e.title)).toEqual(['Standup'])
    expect(day.entries[0]!.actionable).toBe(false)
  })
})

describe('stepDate', () => {
  const M: ISODate = '2026-09-16' // a Wednesday

  it('moves by a day and by a week', () => {
    expect(stepDate(M, 'ArrowLeft', 1)).toBe('2026-09-15')
    expect(stepDate(M, 'ArrowRight', 1)).toBe('2026-09-17')
    expect(stepDate(M, 'ArrowUp', 1)).toBe('2026-09-09')
    expect(stepDate(M, 'ArrowDown', 1)).toBe('2026-09-23')
  })

  it('pages by a month, and by a year with shift', () => {
    expect(stepDate(M, 'PageUp', 1)).toBe('2026-08-16')
    expect(stepDate(M, 'PageDown', 1)).toBe('2026-10-16')
    expect(stepDate(M, 'PageUp', 1, true)).toBe('2025-09-16')
    expect(stepDate(M, 'PageDown', 1, true)).toBe('2027-09-16')
  })

  it('clamps a month step to the shorter month, from the anchor', () => {
    expect(stepDate('2026-03-31', 'PageUp', 1)).toBe('2026-02-28')
  })

  it('goes to the edges of the week the user actually keeps', () => {
    expect(stepDate(M, 'Home', 1)).toBe('2026-09-14')
    expect(stepDate(M, 'End', 1)).toBe('2026-09-20')
    expect(stepDate(M, 'Home', 0)).toBe('2026-09-13')
    expect(stepDate(M, 'End', 0)).toBe('2026-09-19')
  })

  it('declines every other key, so the component can let it through', () => {
    for (const key of ['Enter', ' ', 'a', 'Tab', 'Escape']) {
      expect(stepDate(M, key, 1)).toBeNull()
    }
  })
})

describe('firstOfMonth and monthTitle', () => {
  it('normalise a date to its month', () => {
    expect(firstOfMonth('2026-09-16')).toBe('2026-09-01')
    expect(monthTitle(firstOfMonth('2026-12-31'))).toBe('December 2026')
  })
})
