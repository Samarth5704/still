/**
 * Pure operations over task state.
 *
 * These return a Result rather than throwing: rejecting a nesting attempt or a
 * missing id is an expected condition the UI has to render, not a bug.
 */
import { err, ok } from './types.ts'
import type { Result, State, Task } from './types.ts'

export type StoreErrorCode =
  | 'not-found'
  | 'self-parent'
  | 'parent-is-subtask'
  | 'child-has-children'

export type StoreError = { code: StoreErrorCode; message: string }

const fail = (code: StoreErrorCode, message: string): Result<never, StoreError> =>
  err({ code, message })

const byId = (state: State, id: string): Task | undefined => state.tasks.find((t) => t.id === id)

const hasChildren = (state: State, id: string): boolean =>
  state.tasks.some((t) => t.parentId === id)

export function childrenOf(state: State, parentId: string): Task[] {
  return state.tasks.filter((t) => t.parentId === parentId)
}

/**
 * Attach `childId` to `parentId`, or detach it with `null`.
 *
 * Subtasks are one level deep, not a tree: a task that has a parent cannot take
 * children, and a task that has children cannot become someone's subtask.
 * Enforcing it here is what stops arbitrary nesting and the cycle bugs that
 * come with it.
 */
export function setParent(
  state: State,
  childId: string,
  parentId: string | null,
): Result<State, StoreError> {
  const child = byId(state, childId)
  if (!child) return fail('not-found', `no task ${childId}`)

  if (parentId === null) {
    return ok({ ...state, tasks: state.tasks.map((t) => (t.id === childId ? { ...t, parentId: null } : t)) })
  }

  if (parentId === childId) return fail('self-parent', 'a task cannot be its own parent')

  const parent = byId(state, parentId)
  if (!parent) return fail('not-found', `no task ${parentId}`)
  if (parent.parentId !== null) {
    return fail('parent-is-subtask', `${parentId} is itself a subtask; subtasks are one level deep`)
  }
  if (hasChildren(state, childId)) {
    return fail('child-has-children', `${childId} has subtasks of its own and cannot become one`)
  }

  return ok({
    ...state,
    tasks: state.tasks.map((t) => (t.id === childId ? { ...t, parentId } : t)),
  })
}

export type DeleteOptions = {
  /** Required, with no default: deciding what happens to the children is the user's call. */
  subtasks: 'delete' | 'promote'
}

export function deleteTask(
  state: State,
  id: string,
  options: DeleteOptions,
): Result<State, StoreError> {
  if (!byId(state, id)) return fail('not-found', `no task ${id}`)

  const tasks =
    options.subtasks === 'delete'
      ? state.tasks.filter((t) => t.id !== id && t.parentId !== id)
      : state.tasks
          .filter((t) => t.id !== id)
          .map((t) => (t.parentId === id ? { ...t, parentId: null } : t))

  return ok({ ...state, tasks })
}

export function subtaskProgress(state: State, parentId: string): { done: number; total: number } {
  const children = childrenOf(state, parentId)
  return { done: children.filter((t) => t.done).length, total: children.length }
}
