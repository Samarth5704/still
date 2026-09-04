import { describe, expect, it } from 'vitest'
import type { State, Task } from './types.ts'
import { deleteTask, setParent, subtaskProgress } from './tasks.ts'
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
