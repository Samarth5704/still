import { describe, expect, it } from 'vitest'
import {
  createProject,
  createTag,
  deleteProject,
  deleteTag,
  nextColor,
  projectUsage,
  renameProject,
  renameTag,
  setProjectArchived,
  setProjectColor,
  setTagArchived,
  tagUsage,
} from './catalog.ts'
import { defaultState } from './storage.ts'
import type { Project, State, Tag, Task } from './types.ts'

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

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  colorToken: 'teal',
  icon: 'circle',
  archived: false,
  order: 0,
  ...over,
})

const tag = (id: string, over: Partial<Tag> = {}): Tag => ({
  id,
  name: id,
  colorToken: 'teal',
  archived: false,
  ...over,
})

const expectOk = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.value
}

/**
 * Two projects and two tags. `uni` holds an open task, a completed one, and a
 * task with a subtask; `admin` holds nothing.
 */
const world = (): State => ({
  ...defaultState(),
  projects: [project('uni', { name: 'Uni' }), project('admin', { name: 'Admin', order: 1 })],
  tags: [tag('urgent', { name: 'urgent' }), tag('later', { name: 'later' })],
  tasks: [
    task({ id: 'essay', projectId: 'uni', tagIds: ['urgent'] }),
    task({ id: 'old', projectId: 'uni', done: true }),
    task({ id: 'thesis', projectId: 'uni', tagIds: ['urgent', 'later'] }),
    task({ id: 'chapter', parentId: 'thesis' }),
    task({ id: 'loose', tagIds: ['later'] }),
  ],
})

describe('usage counts', () => {
  it('separates open from completed, because completed ones are why archiving exists', () => {
    expect(projectUsage(world(), 'uni')).toEqual({ open: 2, done: 1, total: 3 })
    expect(projectUsage(world(), 'admin')).toEqual({ open: 0, done: 0, total: 0 })
  })

  it('never counts a subtask: a subtask is not filed anywhere of its own accord', () => {
    // 'chapter' is a subtask of 'thesis', which is in 'uni'. It must not make
    // the project look like it holds four tasks.
    const state: State = {
      ...world(),
      tasks: world().tasks.map((t) => (t.id === 'chapter' ? { ...t, projectId: 'uni' } : t)),
    }
    expect(projectUsage(state, 'uni').total).toBe(3)
  })

  it('counts tag references', () => {
    expect(tagUsage(world(), 'urgent')).toEqual({ open: 2, done: 0, total: 2 })
    expect(tagUsage(world(), 'later')).toEqual({ open: 2, done: 0, total: 2 })
  })
})

describe('creating and renaming', () => {
  it('rejects blank names', () => {
    expect(createProject(world(), 'x', '   ')).toMatchObject({ ok: false, error: { code: 'blank-name' } })
    expect(createTag(world(), 'x', '')).toMatchObject({ ok: false, error: { code: 'blank-name' } })
    expect(renameProject(world(), 'uni', ' ')).toMatchObject({ ok: false, error: { code: 'blank-name' } })
  })

  it('rejects a duplicate name case-insensitively', () => {
    expect(createProject(world(), 'x', 'uni')).toMatchObject({
      ok: false,
      error: { code: 'duplicate-name' },
    })
    expect(renameProject(world(), 'admin', 'UNI')).toMatchObject({
      ok: false,
      error: { code: 'duplicate-name' },
    })
    expect(renameTag(world(), 'later', 'Urgent')).toMatchObject({
      ok: false,
      error: { code: 'duplicate-name' },
    })
  })

  it('lets an entry keep its own name, differing only in case or spacing', () => {
    const renamed = expectOk(renameProject(world(), 'uni', '  Uni  '))
    expect(renamed.projects.find((p) => p.id === 'uni')?.name).toBe('Uni')
  })

  it('collapses internal whitespace rather than storing it', () => {
    const { state } = expectOk(createProject(world(), 'new', '  Side   project '))
    expect(state.projects.find((p) => p.id === 'new')?.name).toBe('Side project')
  })

  it('walks the colour ring so a fresh catalogue is not all one shade', () => {
    expect(nextColor(0)).not.toBe(nextColor(1))
    expect(nextColor(0)).toBe(nextColor(6))
  })

  it('reports an unknown id rather than silently doing nothing', () => {
    expect(renameProject(world(), 'nope', 'x')).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(setProjectColor(world(), 'nope', 'plum')).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
    expect(setTagArchived(world(), 'nope', true)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })
})

describe('archiving', () => {
  it('leaves every reference intact, so an old task still resolves its name', () => {
    const before = world()
    const after = expectOk(setProjectArchived(before, 'uni', true))
    expect(after.projects.find((p) => p.id === 'uni')).toMatchObject({ archived: true, name: 'Uni' })
    expect(after.tasks).toEqual(before.tasks)
  })

  it('is reversible', () => {
    const archived = expectOk(setProjectArchived(world(), 'uni', true))
    const restored = expectOk(setProjectArchived(archived, 'uni', false))
    expect(restored.projects.find((p) => p.id === 'uni')?.archived).toBe(false)
  })

  it('does not mutate the input state', () => {
    const before = world()
    const snapshot = structuredClone(before)
    setProjectArchived(before, 'uni', true)
    setTagArchived(before, 'urgent', true)
    expect(before).toEqual(snapshot)
  })
})

describe('deleteProject', () => {
  it('reassigns its tasks to another project', () => {
    const after = expectOk(deleteProject(world(), 'uni', { tasks: 'reassign', to: 'admin' }))
    expect(after.projects.map((p) => p.id)).toEqual(['admin'])
    expect(after.tasks.filter((t) => t.projectId === 'admin').map((t) => t.id)).toEqual([
      'essay',
      'old',
      'thesis',
    ])
  })

  it('unfiles its tasks when the destination is no project at all', () => {
    const after = expectOk(deleteProject(world(), 'uni', { tasks: 'reassign', to: null }))
    expect(after.tasks.every((t) => t.projectId === null)).toBe(true)
    expect(after.tasks).toHaveLength(5)
  })

  it('deletes its tasks, and their subtasks with them', () => {
    const after = expectOk(deleteProject(world(), 'uni', { tasks: 'delete' }))
    // 'chapter' belonged to 'thesis'; an orphaned checklist item would be worse
    // than either answer the user was offered.
    expect(after.tasks.map((t) => t.id)).toEqual(['loose'])
  })

  it('rejects reassigning to itself or to a project that is not there', () => {
    expect(deleteProject(world(), 'uni', { tasks: 'reassign', to: 'uni' })).toMatchObject({
      ok: false,
      error: { code: 'target-is-self' },
    })
    expect(deleteProject(world(), 'uni', { tasks: 'reassign', to: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'target-not-found' },
    })
  })

  it('rejects an unknown id', () => {
    expect(deleteProject(world(), 'nope', { tasks: 'delete' })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })
})

describe('deleteTag', () => {
  it('removes the tag from its tasks and leaves the tasks alone', () => {
    const after = expectOk(deleteTag(world(), 'urgent', { tasks: 'untag' }))
    expect(after.tags.map((t) => t.id)).toEqual(['later'])
    expect(after.tasks).toHaveLength(5)
    expect(after.tasks.find((t) => t.id === 'essay')?.tagIds).toEqual([])
    expect(after.tasks.find((t) => t.id === 'thesis')?.tagIds).toEqual(['later'])
  })

  it('reassigns to another tag without leaving a task holding it twice', () => {
    // 'thesis' already carries 'later'; folding 'urgent' into it must not
    // produce ['later', 'later'].
    const after = expectOk(deleteTag(world(), 'urgent', { tasks: 'reassign', to: 'later' }))
    expect(after.tasks.find((t) => t.id === 'thesis')?.tagIds).toEqual(['later'])
    expect(after.tasks.find((t) => t.id === 'essay')?.tagIds).toEqual(['later'])
  })

  it('rejects reassigning to itself or to a missing tag', () => {
    expect(deleteTag(world(), 'urgent', { tasks: 'reassign', to: 'urgent' })).toMatchObject({
      ok: false,
      error: { code: 'target-is-self' },
    })
    expect(deleteTag(world(), 'urgent', { tasks: 'reassign', to: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'target-not-found' },
    })
  })

  it('does not mutate the input state', () => {
    const before = world()
    const snapshot = structuredClone(before)
    deleteTag(before, 'urgent', { tasks: 'untag' })
    deleteProject(before, 'uni', { tasks: 'delete' })
    expect(before).toEqual(snapshot)
  })
})
