import { describe, expect, it } from 'vitest'
import type { State, Task } from './types.ts'
import {
  SUBTASK_STRIPPED,
  addSubtask,
  deleteTask,
  setParent,
  shouldPromptToCloseParent,
  subtaskProgress,
} from './tasks.ts'
import { defaultState } from './storage.ts'

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  title: over.id,
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
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const stateWith = (tasks: Task[]): State => ({ ...defaultState(), tasks })

/** parent -> two children, plus an unrelated top-level task. */
const family = (): State =>
  stateWith([
    task({ id: 'parent' }),
    task({ id: 'a', parentId: 'parent', order: 0 }),
    task({ id: 'b', parentId: 'parent', order: 1, done: true }),
    task({ id: 'other' }),
  ])

const expectOk = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.value
}

describe('setParent', () => {
  it('rejects giving a subtask children: one level deep, not a tree', () => {
    const result = setParent(family(), 'other', 'a')
    expect(result).toMatchObject({ ok: false, error: { code: 'parent-is-subtask' } })
  })

  it('rejects turning a task that has children into a subtask', () => {
    const result = setParent(family(), 'parent', 'other')
    expect(result).toMatchObject({ ok: false, error: { code: 'child-has-children' } })
  })

  it('rejects self-parenting', () => {
    expect(setParent(family(), 'parent', 'parent')).toMatchObject({
      ok: false,
      error: { code: 'self-parent' },
    })
  })

  it('rejects unknown ids', () => {
    expect(setParent(family(), 'nope', 'parent')).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
    expect(setParent(family(), 'other', 'nope')).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })

  it('attaches and detaches a plain task without mutating the input', () => {
    const before = family()
    const snapshot = structuredClone(before)
    const attached = expectOk(setParent(before, 'other', 'parent'))
    expect(before).toEqual(snapshot)
    expect(attached.tasks.find((t) => t.id === 'other')?.parentId).toBe('parent')

    const detached = expectOk(setParent(attached, 'other', null))
    expect(detached.tasks.find((t) => t.id === 'other')?.parentId).toBe(null)
  })
})

describe('the two doors into subtask-hood agree', () => {
  /*
   * `addSubtask` mints a thin task; `setParent` attaches one that already
   * exists and may be carrying anything. Before recurrence went live the second
   * door merely leaked a due date; now it would hand a checklist item a live
   * rule, and `setDone` routes on `recurrenceId` — so ticking the item would
   * try to advance an occurrence of it.
   */
  it('setParent thins an existing task on the way in', () => {
    const before = stateWith([
      task({ id: 'parent' }),
      task({
        id: 'repeater',
        due: '2026-03-01',
        dueTime: '09:00',
        projectId: 'uni',
        tagIds: ['t1'],
        recurrenceId: 'r1',
      }),
    ])

    const next = expectOk(setParent(before, 'repeater', 'parent'))
    expect(next.tasks.find((t) => t.id === 'repeater')).toMatchObject({
      parentId: 'parent',
      ...SUBTASK_STRIPPED,
    })
  })

  it('strips the same fields whichever door was used', () => {
    const loaded = { due: '2026-03-01', dueTime: '09:00', projectId: 'uni', tagIds: ['t1'], recurrenceId: 'r1' }

    const attached = expectOk(
      setParent(stateWith([task({ id: 'parent' }), task({ id: 'x', ...loaded })]), 'x', 'parent'),
    ).tasks.find((t) => t.id === 'x')!
    const added = expectOk(
      addSubtask(stateWith([task({ id: 'parent' })]), 'parent', task({ id: 'y', ...loaded })),
    ).tasks.find((t) => t.id === 'y')!

    for (const field of Object.keys(SUBTASK_STRIPPED) as (keyof Task)[]) {
      expect(attached[field]).toEqual(added[field])
    }
  })

  it('promoting a subtask puts nothing back, because nothing was kept', () => {
    const promoted = expectOk(setParent(family(), 'a', null)).tasks.find((t) => t.id === 'a')!
    expect(promoted).toMatchObject({ parentId: null, ...SUBTASK_STRIPPED })
  })
})

describe('deleteTask', () => {
  it('promotes children to top level, preserving their order', () => {
    const next = expectOk(deleteTask(family(), 'parent', { subtasks: 'promote' }))
    expect(next.tasks.map((t) => t.id)).toEqual(['a', 'b', 'other'])
    expect(next.tasks.filter((t) => t.parentId !== null)).toEqual([])
    expect(next.tasks.find((t) => t.id === 'a')?.order).toBe(0)
    expect(next.tasks.find((t) => t.id === 'b')?.order).toBe(1)
  })

  it('deletes children along with the parent', () => {
    const next = expectOk(deleteTask(family(), 'parent', { subtasks: 'delete' }))
    expect(next.tasks.map((t) => t.id)).toEqual(['other'])
  })

  it('removes a childless task under either policy', () => {
    for (const subtasks of ['delete', 'promote'] as const) {
      const next = expectOk(deleteTask(family(), 'other', { subtasks }))
      expect(next.tasks.map((t) => t.id)).toEqual(['parent', 'a', 'b'])
    }
  })

  it('rejects an unknown id', () => {
    expect(deleteTask(family(), 'nope', { subtasks: 'delete' })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })
})

describe('subtaskProgress', () => {
  it('counts done against total', () => {
    expect(subtaskProgress(family(), 'parent')).toEqual({ done: 1, total: 2 })
    expect(subtaskProgress(family(), 'other')).toEqual({ done: 0, total: 0 })
  })
})

/**
 * Every field on `Task`, classified.
 *
 * This is a type-level exhaustiveness check first and a test second: `Record<
 * keyof Task, ...>` will not compile if a field is missing or invented, so
 * adding one to `Task` without deciding what a subtask does with it breaks the
 * build. That is the error CLAUDE.md says a silent inherit does not give you —
 * an unclassified field is inherited by default, which is the wrong default and
 * fails quietly.
 */
const CLASSIFIED: Record<keyof Task, 'stripped' | 'own'> = {
  id: 'own',
  title: 'own',
  notes: 'own',
  done: 'own',
  completedAt: 'own',
  due: 'stripped',
  dueTime: 'stripped',
  priority: 'own',
  projectId: 'stripped',
  tagIds: 'stripped',
  parentId: 'own',
  order: 'own',
  // A checklist item cannot repeat: an occurrence of a tick is meaningless,
  // and `setDone` routes on this field.
  recurrenceId: 'stripped',
  createdAt: 'own',
}

describe('SUBTASK_STRIPPED', () => {
  it('is exactly the set of fields classified as stripped', () => {
    const stripped = Object.entries(CLASSIFIED)
      .filter(([, kind]) => kind === 'stripped')
      .map(([field]) => field)
      .sort()
    expect(Object.keys(SUBTASK_STRIPPED).sort()).toEqual(stripped)
  })
})

describe('addSubtask', () => {
  const fresh = (over: Partial<Task> = {}) => task({ id: 'new', ...over })

  it('strips the fields that would make it a task rather than a checklist item', () => {
    const next = expectOk(
      addSubtask(
        family(),
        'parent',
        fresh({
          due: '2026-03-01',
          dueTime: '09:00',
          projectId: 'uni',
          tagIds: ['t1'],
          recurrenceId: 'r1',
        }),
      ),
    )
    expect(next.tasks.find((t) => t.id === 'new')).toMatchObject({
      parentId: 'parent',
      due: null,
      dueTime: null,
      projectId: null,
      tagIds: [],
      recurrenceId: null,
    })
  })

  it('appends after the existing subtasks', () => {
    const next = expectOk(addSubtask(family(), 'parent', fresh()))
    expect(next.tasks.find((t) => t.id === 'new')?.order).toBe(2)
  })

  it('refuses to hang a subtask off a subtask', () => {
    expect(addSubtask(family(), 'a', fresh())).toMatchObject({
      ok: false,
      error: { code: 'parent-is-subtask' },
    })
  })

  it('refuses an unknown parent and a duplicate id', () => {
    expect(addSubtask(family(), 'nope', fresh())).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
    expect(addSubtask(family(), 'parent', fresh({ id: 'other' }))).toMatchObject({ ok: false })
  })

  it('does not mutate the input state', () => {
    const before = family()
    const snapshot = structuredClone(before)
    addSubtask(before, 'parent', fresh())
    expect(before).toEqual(snapshot)
  })
})

describe('shouldPromptToCloseParent', () => {
  it('is false while anything is outstanding', () => {
    expect(shouldPromptToCloseParent(family(), 'parent')).toBe(false)
  })

  it('is true once every subtask is ticked and the parent is not', () => {
    const all = stateWith([
      task({ id: 'parent' }),
      task({ id: 'a', parentId: 'parent', done: true }),
      task({ id: 'b', parentId: 'parent', done: true }),
    ])
    expect(shouldPromptToCloseParent(all, 'parent')).toBe(true)
  })

  it('is false for a parent that is already done: there is nothing to offer', () => {
    const closed = stateWith([
      task({ id: 'parent', done: true }),
      task({ id: 'a', parentId: 'parent', done: true }),
    ])
    expect(shouldPromptToCloseParent(closed, 'parent')).toBe(false)
  })

  it('is false for a task with no subtasks at all', () => {
    expect(shouldPromptToCloseParent(family(), 'other')).toBe(false)
    expect(shouldPromptToCloseParent(family(), 'nope')).toBe(false)
  })
})
