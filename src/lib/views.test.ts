import { describe, expect, it } from 'vitest'
import {
  bucketFor,
  compareTasks,
  dueLabel,
  formatHash,
  groupByDue,
  groupsForView,
  isClear,
  monthWindow,
  nextOrder,
  parseHash,
  reorder,
  sameView,
  tasksForView,
  timeLabel,
  viewCounts,
  viewTitle,
} from './views.ts'
import type { View } from './views.ts'
import { defaultState } from './storage.ts'
import type { ISODate, Priority, State, Task } from './types.ts'

// Saturday.
const TODAY: ISODate = '2026-09-05'

let seq = 0
function task(over: Partial<Task> = {}): Task {
  seq += 1
  return {
    id: over.id ?? `t${seq}`,
    title: over.title ?? `task ${seq}`,
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
    createdAt: `2026-01-01T00:00:0${seq % 10}.000Z`,
    ...over,
  }
}

function stateWith(tasks: Task[]): State {
  return { ...defaultState(), tasks }
}

describe('tasksForView', () => {
  it('excludes completed tasks from every list view', () => {
    const s = stateWith([task({ due: TODAY, done: true }), task({ due: TODAY })])
    expect(tasksForView(s, { kind: 'today' }, TODAY)).toHaveLength(1)
    expect(tasksForView(s, { kind: 'all' }, TODAY)).toHaveLength(1)
  })

  it('excludes subtasks: they belong to their parent row, not to a list', () => {
    const s = stateWith([task({ id: 'p' }), task({ parentId: 'p', due: TODAY })])
    expect(tasksForView(s, { kind: 'all' }, TODAY).map((t) => t.id)).toEqual(['p'])
  })

  it('Today includes overdue as well as due-today', () => {
    const s = stateWith([
      task({ id: 'late', due: '2026-09-01' }),
      task({ id: 'now', due: TODAY }),
      task({ id: 'soon', due: '2026-09-06' }),
      task({ id: 'undated' }),
    ])
    expect(tasksForView(s, { kind: 'today' }, TODAY).map((t) => t.id)).toEqual(['late', 'now'])
  })

  it('Upcoming is strictly future and excludes undated tasks', () => {
    const s = stateWith([
      task({ id: 'late', due: '2026-09-01' }),
      task({ id: 'now', due: TODAY }),
      task({ id: 'soon', due: '2026-09-06' }),
      task({ id: 'undated' }),
    ])
    expect(tasksForView(s, { kind: 'upcoming' }, TODAY).map((t) => t.id)).toEqual(['soon'])
  })

  it('All includes undated tasks, sorted after the dated ones', () => {
    const s = stateWith([task({ id: 'undated' }), task({ id: 'dated', due: '2026-09-20' })])
    expect(tasksForView(s, { kind: 'all' }, TODAY).map((t) => t.id)).toEqual(['dated', 'undated'])
  })

  it('a project list uses manual order, not the calendar', () => {
    const s = stateWith([
      task({ id: 'a', projectId: 'p', order: 2, due: '2026-09-06' }),
      task({ id: 'b', projectId: 'p', order: 0, due: '2026-12-01' }),
      task({ id: 'c', projectId: 'p', order: 1 }),
      task({ id: 'other', projectId: 'q', order: 0 }),
    ])
    expect(tasksForView(s, { kind: 'project', id: 'p' }, TODAY).map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('a tag list filters by membership', () => {
    const s = stateWith([task({ id: 'a', tagIds: ['x'] }), task({ id: 'b', tagIds: ['y'] })])
    expect(tasksForView(s, { kind: 'tag', id: 'x' }, TODAY).map((t) => t.id)).toEqual(['a'])
  })
})

describe('compareTasks', () => {
  const withDue = (id: string, due: ISODate | null, priority: Priority = 'none', order = 0) =>
    task({ id, due, priority, order })

  it('puts dated tasks before undated ones', () => {
    expect(compareTasks(withDue('a', '2030-01-01'), withDue('b', null))).toBeLessThan(0)
  })

  it('sorts earlier dates first', () => {
    expect(compareTasks(withDue('a', '2026-09-06'), withDue('b', '2026-09-07'))).toBeLessThan(0)
  })

  it('breaks a date tie by priority', () => {
    expect(compareTasks(withDue('a', TODAY, 'urgent'), withDue('b', TODAY, 'low'))).toBeLessThan(0)
  })

  it('breaks a priority tie by manual order', () => {
    expect(compareTasks(withDue('a', TODAY, 'none', 0), withDue('b', TODAY, 'none', 1))).toBeLessThan(0)
  })

  it('never lets manual order outrank a due date', () => {
    const dragged = withDue('dragged', null, 'urgent', 0)
    const dueToday = withDue('due', TODAY, 'none', 99)
    expect(compareTasks(dueToday, dragged)).toBeLessThan(0)
  })
})

describe('bucketFor', () => {
  it('labels overdue, today and tomorrow', () => {
    expect(bucketFor('2026-09-01', TODAY, 1).title).toBe('Overdue')
    expect(bucketFor(TODAY, TODAY, 1).title).toBe('Today')
    expect(bucketFor('2026-09-06', TODAY, 1).title).toBe('Tomorrow')
  })

  it('collapses every overdue date into one group', () => {
    expect(bucketFor('2026-09-01', TODAY, 1).key).toBe(bucketFor('2026-08-01', TODAY, 1).key)
  })

  it('names weekdays inside the current week', () => {
    // Sat 5 Sep, Monday-start week: only Sunday the 6th is left in it, and that
    // is "Tomorrow". With a Sunday-start week the 7th onward is next week.
    expect(bucketFor('2026-09-06', TODAY, 1).title).toBe('Tomorrow')
    expect(bucketFor('2026-09-07', TODAY, 1).title).toBe('Next Monday')
  })

  it('names weekdays inside the current week when the week has room left', () => {
    // Monday 7 Sep: the rest of that week is named plainly.
    expect(bucketFor('2026-09-09', '2026-09-07', 1).title).toBe('Wednesday')
    expect(bucketFor('2026-09-14', '2026-09-07', 1).title).toBe('Next Monday')
  })

  it('falls back to a date beyond two weeks', () => {
    expect(bucketFor('2026-10-20', TODAY, 1).title).toBe('20 October')
  })

  it('includes the year for a date in another year', () => {
    expect(bucketFor('2027-10-20', TODAY, 1).title).toBe('20 October 2027')
  })

  it('has a group for undated tasks', () => {
    expect(bucketFor(null, TODAY, 1)).toEqual({ key: 'none', title: 'No date', tone: 'none' })
  })

  it('respects weekStart when deciding what "this week" means', () => {
    // Sunday 6 Sep. Sunday-start: the whole week ahead is "this week".
    expect(bucketFor('2026-09-09', '2026-09-06', 0).title).toBe('Wednesday')
    // Monday-start: Sunday is the last day of its week, so the 9th is next week.
    expect(bucketFor('2026-09-09', '2026-09-06', 1).title).toBe('Next Wednesday')
  })
})

describe('groupByDue', () => {
  it('emits groups in first-appearance order and keeps task order inside them', () => {
    const tasks = [
      task({ id: 'late', due: '2026-09-01' }),
      task({ id: 'late2', due: '2026-09-02' }),
      task({ id: 'now', due: TODAY }),
      task({ id: 'undated' }),
    ]
    const groups = groupByDue(tasks, TODAY, 1)
    expect(groups.map((g) => g.title)).toEqual(['Overdue', 'Today', 'No date'])
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(['late', 'late2'])
  })

  it('returns no groups for an empty list', () => {
    expect(groupByDue([], TODAY, 1)).toEqual([])
  })

  it('marks the overdue group with an overdue tone', () => {
    const groups = groupByDue([task({ due: '2026-09-01' })], TODAY, 1)
    expect(groups[0]!.tone).toBe('overdue')
  })
})

describe('groupsForView', () => {
  it('gives a project one untitled group in manual order', () => {
    const s = stateWith([
      task({ id: 'a', projectId: 'p', order: 1 }),
      task({ id: 'b', projectId: 'p', order: 0 }),
    ])
    const groups = groupsForView(s, { kind: 'project', id: 'p' }, TODAY, 1)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.title).toBe('')
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('gives an empty project no groups at all', () => {
    expect(groupsForView(stateWith([]), { kind: 'project', id: 'p' }, TODAY, 1)).toEqual([])
  })
})

describe('viewCounts', () => {
  it('counts each view in one pass', () => {
    const s = stateWith([
      task({ due: '2026-09-01', projectId: 'p', tagIds: ['x'] }),
      task({ due: TODAY, projectId: 'p' }),
      task({ due: '2026-09-20', tagIds: ['x', 'y'] }),
      task({ tagIds: ['y'] }),
      task({ done: true, due: TODAY }),
      task({ parentId: 'nope', due: TODAY }),
    ])
    const c = viewCounts(s, TODAY)
    expect(c.all).toBe(4)
    expect(c.today).toBe(2)
    expect(c.overdue).toBe(1)
    expect(c.upcoming).toBe(1)
    expect(c.byProject.get('p')).toBe(2)
    expect(c.byTag.get('x')).toBe(2)
    expect(c.byTag.get('y')).toBe(2)
  })

  it('counts an overdue task in Today as well as in overdue', () => {
    const c = viewCounts(stateWith([task({ due: '2026-01-01' })]), TODAY)
    expect(c.overdue).toBe(1)
    expect(c.today).toBe(1)
  })

  it('is all zeroes on an empty state', () => {
    const c = viewCounts(defaultState(), TODAY)
    expect([c.all, c.today, c.upcoming, c.overdue]).toEqual([0, 0, 0, 0])
  })
})

describe('nextOrder', () => {
  it('lands a new task after the last one in its list', () => {
    const tasks = [task({ projectId: 'p', order: 0 }), task({ projectId: 'p', order: 4 })]
    expect(nextOrder(tasks, 'p')).toBe(5)
  })

  it('starts at zero for an empty list', () => {
    expect(nextOrder([], null)).toBe(0)
  })

  it('counts only the target list', () => {
    expect(nextOrder([task({ projectId: 'other', order: 9 })], 'p')).toBe(0)
  })
})

describe('reorder', () => {
  const list = () => [
    task({ id: 'a', projectId: 'p', order: 0 }),
    task({ id: 'b', projectId: 'p', order: 1 }),
    task({ id: 'c', projectId: 'p', order: 2 }),
  ]

  const orderOf = (tasks: Task[]) =>
    tasks
      .slice()
      .sort((x, y) => x.order - y.order)
      .map((t) => t.id)

  it('moves a task up', () => {
    expect(orderOf(reorder(list(), 'c', -1))).toEqual(['a', 'c', 'b'])
  })

  it('moves a task down', () => {
    expect(orderOf(reorder(list(), 'a', 1))).toEqual(['b', 'a', 'c'])
  })

  it('is a no-op at the top', () => {
    expect(orderOf(reorder(list(), 'a', -1))).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op at the bottom', () => {
    expect(orderOf(reorder(list(), 'c', 1))).toEqual(['a', 'b', 'c'])
  })

  it('rewrites duplicate orders densely instead of preserving the collision', () => {
    const tasks = [
      task({ id: 'a', projectId: 'p', order: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
      task({ id: 'b', projectId: 'p', order: 0, createdAt: '2026-01-02T00:00:00.000Z' }),
      task({ id: 'c', projectId: 'p', order: 0, createdAt: '2026-01-03T00:00:00.000Z' }),
    ]
    const moved = reorder(tasks, 'c', -1)
    expect(moved.map((t) => t.order).sort()).toEqual([0, 1, 2])
    expect(orderOf(moved)).toEqual(['a', 'c', 'b'])
  })

  it('only reorders within the same project', () => {
    const tasks = [
      task({ id: 'a', projectId: 'p', order: 0 }),
      task({ id: 'x', projectId: 'q', order: 0 }),
      task({ id: 'b', projectId: 'p', order: 1 }),
    ]
    const moved = reorder(tasks, 'b', -1)
    expect(moved.find((t) => t.id === 'x')!.order).toBe(0)
    expect(moved.find((t) => t.id === 'b')!.order).toBe(0)
  })

  it('leaves the list alone for an unknown id', () => {
    expect(orderOf(reorder(list(), 'nope', 1))).toEqual(['a', 'b', 'c'])
  })

  it('refuses to reorder a subtask through the top-level list', () => {
    const tasks = [...list(), task({ id: 'sub', parentId: 'a' })]
    expect(reorder(tasks, 'sub', -1).find((t) => t.id === 'sub')!.order).toBe(0)
  })
})

describe('labels', () => {
  it('names the days around today', () => {
    expect(dueLabel(TODAY, TODAY)).toBe('Today')
    expect(dueLabel('2026-09-06', TODAY)).toBe('Tomorrow')
    expect(dueLabel('2026-09-04', TODAY)).toBe('Yesterday')
  })

  it('counts days for anything further overdue', () => {
    expect(dueLabel('2026-09-01', TODAY)).toBe('4 days ago')
  })

  it('returns null with no due date', () => {
    expect(dueLabel(null, TODAY)).toBeNull()
  })

  it('formats times in 12-hour form', () => {
    expect(timeLabel('17:00')).toBe('5 pm')
    expect(timeLabel('09:15')).toBe('9:15 am')
    expect(timeLabel('00:00')).toBe('12 am')
    expect(timeLabel('12:00')).toBe('12 pm')
  })

  it('returns null for no time', () => {
    expect(timeLabel(null)).toBeNull()
  })
})

describe('monthWindow', () => {
  it('pads to whole weeks and always spans six rows', () => {
    const w = monthWindow('2026-09-01', 1)
    expect(w.start).toBe('2026-08-31')
    expect(w.end).toBe('2026-10-11')
  })

  it('respects a Sunday week start', () => {
    expect(monthWindow('2026-09-01', 0).start).toBe('2026-08-30')
  })
})

describe('hash round-trip', () => {
  const views: View[] = [
    { kind: 'today' },
    { kind: 'upcoming' },
    { kind: 'all' },
    { kind: 'calendar' },
    { kind: 'project', id: 'p1' },
    { kind: 'tag', id: 't1' },
  ]

  it('round-trips every view', () => {
    for (const v of views) expect(parseHash(formatHash(v))).toEqual(v)
  })

  it('treats an empty hash as Today', () => {
    expect(parseHash('')).toEqual({ kind: 'today' })
    expect(parseHash('#')).toEqual({ kind: 'today' })
    expect(parseHash('#/')).toEqual({ kind: 'today' })
  })

  it('falls back to Today rather than throwing on a stale link', () => {
    expect(parseHash('#/nonsense')).toEqual({ kind: 'today' })
    expect(parseHash('#/project')).toEqual({ kind: 'today' })
  })

  it('escapes and restores an id with awkward characters', () => {
    const view: View = { kind: 'project', id: 'a/b c#d' }
    expect(parseHash(formatHash(view))).toEqual(view)
  })

  it('compares views by identity, not by reference', () => {
    expect(sameView({ kind: 'today' }, { kind: 'today' })).toBe(true)
    expect(sameView({ kind: 'project', id: 'a' }, { kind: 'project', id: 'b' })).toBe(false)
    expect(sameView({ kind: 'project', id: 'a' }, { kind: 'tag', id: 'a' })).toBe(false)
  })
})

describe('viewTitle', () => {
  it('names built-in views', () => {
    expect(viewTitle({ kind: 'today' }, defaultState())).toBe('Today')
    expect(viewTitle({ kind: 'all' }, defaultState())).toBe('All tasks')
  })

  it('resolves a project name, and survives a missing one', () => {
    const s: State = {
      ...defaultState(),
      projects: [{ id: 'p', name: 'Thesis', colorToken: 'teal', icon: 'circle', archived: false, order: 0 }],
    }
    expect(viewTitle({ kind: 'project', id: 'p' }, s)).toBe('Thesis')
    expect(viewTitle({ kind: 'project', id: 'gone' }, s)).toBe('Project')
  })

  it('prefixes a tag name with an at sign', () => {
    const s: State = { ...defaultState(), tags: [{ id: 't', name: 'deep', colorToken: 'teal', archived: false }] }
    expect(viewTitle({ kind: 'tag', id: 't' }, s)).toBe('@deep')
  })
})

describe('isClear', () => {
  it('is true with nothing due or overdue', () => {
    expect(isClear(stateWith([task({ due: '2026-12-01' }), task({})]), TODAY)).toBe(true)
  })

  it('is false with something due today', () => {
    expect(isClear(stateWith([task({ due: TODAY })]), TODAY)).toBe(false)
  })

  it('is false with something overdue', () => {
    expect(isClear(stateWith([task({ due: '2026-01-01' })]), TODAY)).toBe(false)
  })
})
