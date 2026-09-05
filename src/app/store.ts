/**
 * The app's single mutable cell.
 *
 * Everything below `lib/` is pure; this is where impurity is allowed to live,
 * and it is deliberately the only place: the clock, `localStorage`, id
 * generation and subscription bookkeeping all sit here so no view module ever
 * reaches for a global.
 *
 * State transitions are whole-object replacements produced by pure functions.
 * That is what makes undo a one-liner — keep the previous object — rather than
 * a per-action inverse that has to be written and maintained for every edit.
 */
import { toISODate } from '../lib/dates.ts'
import { parseState, serialiseState } from '../lib/storage.ts'
import { computePressure } from '../lib/pressure.ts'
import { nextOrder, reorder } from '../lib/views.ts'
import * as catalog from '../lib/catalog.ts'
import { addSubtask, deleteTask } from '../lib/tasks.ts'
import type { CatalogError, ProjectDisposition, TagDisposition } from '../lib/catalog.ts'
import type { DeleteOptions, StoreError } from '../lib/tasks.ts'
import type { RecurrenceDraft } from '../lib/parse.ts'
import type {
  ISODate,
  Priority,
  PressureSummary,
  Project,
  Recurrence,
  Result,
  State,
  Tag,
  Task,
} from '../lib/types.ts'

const STORAGE_KEY = 'still:state:v1'

/** Long enough to reach for, short enough not to loiter. Matches the toast. */
export const UNDO_WINDOW_MS = 8000

export type Snapshot = {
  state: State
  /** Shown on the undo affordance: "Completed 'Submit finance assignment'". */
  label: string
  at: number
}

export type StoreEvent = {
  state: State
  today: ISODate
  pressure: PressureSummary
  /** What changed, for listeners that only care about some of it. */
  cause: 'init' | 'mutate' | 'undo' | 'today' | 'storage'
}

type Listener = (event: StoreEvent) => void

function newId(): string {
  // Modern evergreen browsers only, per the stack constraints.
  return crypto.randomUUID()
}

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    // Private mode, disabled storage, quota games. Opening still has to work.
    return null
  }
}

export class Store {
  private state: State
  private today: ISODate
  private readonly listeners = new Set<Listener>()
  private undoStack: Snapshot[] = []
  private writeHandle: number | null = null

  /**
   * True when the stored data came from a newer build. Everything still works
   * in memory; nothing is ever written back, because overwriting data this
   * version cannot read would destroy it.
   */
  readonly readOnly: boolean
  readonly loadReason: string | undefined

  constructor(now: Date = new Date()) {
    const loaded = parseState(readStorage())
    this.state = loaded.state
    this.readOnly = loaded.mode === 'read-only'
    this.loadReason = loaded.reason
    this.today = toISODate(now)
  }

  getState(): State {
    return this.state
  }

  getToday(): ISODate {
    return this.today
  }

  getPressure(): PressureSummary {
    return computePressure(this.state.tasks, this.today)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(cause: StoreEvent['cause']): void {
    const event: StoreEvent = {
      state: this.state,
      today: this.today,
      pressure: this.getPressure(),
      cause,
    }
    for (const listener of this.listeners) listener(event)
  }

  /** Announce the state the app booted with, once listeners are attached. */
  start(): void {
    this.emit('init')
  }

  /**
   * Re-read the clock. Called on visibility change and from a midnight timer:
   * a tab left open overnight must not keep calling yesterday "today", because
   * every due-date label and the whole pressure number depend on it.
   */
  refreshToday(now: Date = new Date()): void {
    const today = toISODate(now)
    if (today === this.today) return
    this.today = today
    this.emit('today')
  }

  /**
   * Apply a pure transition. `label` makes the change undoable; omit it for
   * changes that should not appear in the undo stack.
   */
  private commit(next: State, label?: string): void {
    if (label !== undefined) {
      this.undoStack.push({ state: this.state, label, at: Date.now() })
      // One step back is what the UI offers; keeping more costs memory for a
      // depth nothing in the interface exposes.
      if (this.undoStack.length > 20) this.undoStack.shift()
    }
    this.state = next
    this.persist()
    this.emit('mutate')
  }

  private persist(): void {
    if (this.readOnly) return
    if (this.writeHandle !== null) clearTimeout(this.writeHandle)
    // Coalesce bursts — typing in the detail dialog, a run of completions —
    // into one write rather than serialising the whole state per keystroke.
    this.writeHandle = window.setTimeout(() => {
      this.writeHandle = null
      try {
        localStorage.setItem(STORAGE_KEY, serialiseState(this.state))
      } catch {
        // A full or unavailable store must not take the app down with it.
      }
    }, 250)
  }

  /** Flush any pending write immediately, for `pagehide`. */
  flush(): void {
    if (this.readOnly || this.writeHandle === null) return
    clearTimeout(this.writeHandle)
    this.writeHandle = null
    try {
      localStorage.setItem(STORAGE_KEY, serialiseState(this.state))
    } catch {
      /* nothing useful to do */
    }
  }

  peekUndo(): Snapshot | null {
    return this.undoStack[this.undoStack.length - 1] ?? null
  }

  undo(): Snapshot | null {
    const snapshot = this.undoStack.pop()
    if (!snapshot) return null
    this.state = snapshot.state
    this.persist()
    this.emit('undo')
    return snapshot
  }

  /** Drop an undo entry once its window has closed, so it cannot fire later. */
  expireUndo(snapshot: Snapshot): void {
    const top = this.undoStack[this.undoStack.length - 1]
    if (top === snapshot) this.undoStack.pop()
  }

  // ---- projects and tags -------------------------------------------------

  /**
   * Find a project by name, case-insensitively, or create one. Quick-add types
   * `#uni` and expects it to work whether or not the project already exists.
   */
  ensureProject(name: string): { state: State; project: Project } {
    const existing = this.state.projects.find(
      (p) => p.name.toLowerCase() === name.toLowerCase() && !p.archived,
    )
    if (existing) return { state: this.state, project: existing }

    const project: Project = {
      id: newId(),
      name,
      colorToken: catalog.nextColor(this.state.projects.length),
      icon: 'circle',
      archived: false,
      order: this.state.projects.length,
    }
    return { state: { ...this.state, projects: [...this.state.projects, project] }, project }
  }

  ensureTag(state: State, name: string): { state: State; tag: Tag } {
    const existing = state.tags.find(
      (t) => t.name.toLowerCase() === name.toLowerCase() && !t.archived,
    )
    if (existing) return { state, tag: existing }

    const tag: Tag = {
      id: newId(),
      name,
      colorToken: catalog.nextColor(state.tags.length),
      archived: false,
    }
    return { state: { ...state, tags: [...state.tags, tag] }, tag }
  }

  /**
   * Run a pure catalogue transition and commit it, or hand the error back for
   * the UI to render. Rejecting a blank or duplicate name is an expected
   * condition a form has to show, not a bug to throw over.
   */
  private applyCatalog(
    result: Result<State, CatalogError>,
    label: string,
  ): Result<State, CatalogError> {
    if (result.ok) this.commit(result.value, label)
    return result
  }

  createProject(name: string): Result<State, CatalogError> {
    const made = catalog.createProject(this.state, newId(), name)
    if (!made.ok) return made
    this.commit(made.value.state, `Added project "${made.value.project.name}"`)
    return { ok: true, value: made.value.state }
  }

  renameProject(id: string, name: string): Result<State, CatalogError> {
    return this.applyCatalog(catalog.renameProject(this.state, id, name), 'Renamed project')
  }

  setProjectColor(id: string, colorToken: string): Result<State, CatalogError> {
    return this.applyCatalog(catalog.setProjectColor(this.state, id, colorToken), 'Recoloured project')
  }

  setProjectArchived(id: string, archived: boolean): Result<State, CatalogError> {
    return this.applyCatalog(
      catalog.setProjectArchived(this.state, id, archived),
      archived ? 'Archived project' : 'Restored project',
    )
  }

  deleteProject(id: string, disposition: ProjectDisposition): Result<State, CatalogError> {
    return this.applyCatalog(catalog.deleteProject(this.state, id, disposition), 'Deleted project')
  }

  createTag(name: string): Result<State, CatalogError> {
    const made = catalog.createTag(this.state, newId(), name)
    if (!made.ok) return made
    this.commit(made.value.state, `Added tag "${made.value.tag.name}"`)
    return { ok: true, value: made.value.state }
  }

  renameTag(id: string, name: string): Result<State, CatalogError> {
    return this.applyCatalog(catalog.renameTag(this.state, id, name), 'Renamed tag')
  }

  setTagColor(id: string, colorToken: string): Result<State, CatalogError> {
    return this.applyCatalog(catalog.setTagColor(this.state, id, colorToken), 'Recoloured tag')
  }

  setTagArchived(id: string, archived: boolean): Result<State, CatalogError> {
    return this.applyCatalog(
      catalog.setTagArchived(this.state, id, archived),
      archived ? 'Archived tag' : 'Restored tag',
    )
  }

  deleteTag(id: string, disposition: TagDisposition): Result<State, CatalogError> {
    return this.applyCatalog(catalog.deleteTag(this.state, id, disposition), 'Deleted tag')
  }

  // ---- tasks -------------------------------------------------------------

  /**
   * Create a task from a parsed quick-add line, minting any project, tag or
   * recurrence it referred to. Returns the new task's id.
   */
  addTask(input: {
    title: string
    due?: ISODate | null
    dueTime?: string | null
    priority?: Priority
    projectName?: string | null
    projectId?: string | null
    tagNames?: string[]
    recurrence?: RecurrenceDraft | null
    notes?: string
  }): string {
    let next = this.state

    let projectId = input.projectId ?? null
    if (input.projectName) {
      const resolved = this.ensureProject(input.projectName)
      next = resolved.state
      projectId = resolved.project.id
    }

    const tagIds: string[] = []
    for (const name of input.tagNames ?? []) {
      const resolved = this.ensureTag(next, name)
      next = resolved.state
      tagIds.push(resolved.tag.id)
    }

    let recurrenceId: string | null = null
    let due = input.due ?? null
    if (input.recurrence) {
      const rule: Recurrence = { ...input.recurrence, id: newId(), ends: { type: 'never' }, exceptions: [] }
      next = { ...next, recurrences: [...next.recurrences, rule] }
      recurrenceId = rule.id
      // A repeating task is due on its first occurrence unless the line said
      // otherwise, so it appears in a list rather than sitting dateless.
      if (due === null) due = rule.starts
    }

    const task: Task = {
      id: newId(),
      title: input.title,
      notes: input.notes ?? '',
      done: false,
      completedAt: null,
      due,
      dueTime: input.dueTime ?? null,
      priority: input.priority ?? 'none',
      projectId,
      tagIds,
      parentId: null,
      order: nextOrder(next.tasks, projectId),
      recurrenceId,
      createdAt: new Date().toISOString(),
    }

    this.commit({ ...next, tasks: [...next.tasks, task] }, `Added "${task.title}"`)
    return task.id
  }

  updateTask(id: string, patch: Partial<Task>, label?: string): void {
    this.commit(
      { ...this.state, tasks: this.state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) },
      label,
    )
  }

  /**
   * Complete or reopen a task.
   *
   * Completing a parent completes its remaining subtasks with it — silently,
   * and undoably, because the whole change is one snapshot (Phase 4 states this
   * rule; honouring it here keeps the two from disagreeing).
   */
  setDone(id: string, done: boolean): void {
    const task = this.state.tasks.find((t) => t.id === id)
    if (!task) return
    const completedAt = done ? new Date().toISOString() : null

    const tasks = this.state.tasks.map((t) => {
      if (t.id === id) return { ...t, done, completedAt }
      if (done && t.parentId === id && !t.done) return { ...t, done: true, completedAt }
      return t
    })

    this.commit({ ...this.state, tasks }, done ? `Completed "${task.title}"` : `Reopened "${task.title}"`)
  }

  /**
   * Add a checklist item under `parentId`. `lib/tasks.ts` strips the fields a
   * subtask is not allowed to carry, so there is exactly one place that decides
   * what "thin" means.
   */
  addSubtask(parentId: string, title: string): Result<State, StoreError> {
    const subtask: Task = {
      id: newId(),
      title,
      notes: '',
      done: false,
      completedAt: null,
      due: null,
      dueTime: null,
      priority: 'none',
      projectId: null,
      tagIds: [],
      parentId,
      order: 0,
      recurrenceId: null,
      createdAt: new Date().toISOString(),
    }
    const result = addSubtask(this.state, parentId, subtask)
    if (result.ok) this.commit(result.value, `Added subtask "${title}"`)
    return result
  }

  /**
   * Delete a task. `options.subtasks` has no default: what happens to the
   * children is the user's call, asked with the counts in front of them.
   */
  deleteTask(id: string, options: DeleteOptions): Result<State, StoreError> {
    const task = this.state.tasks.find((t) => t.id === id)
    const result = deleteTask(this.state, id, options)
    if (result.ok) this.commit(result.value, `Deleted "${task?.title ?? 'task'}"`)
    return result
  }

  /** Detach a recurrence from a task, leaving the task itself in place. */
  clearRecurrence(id: string): void {
    const task = this.state.tasks.find((t) => t.id === id)
    if (!task || task.recurrenceId === null) return
    const ruleId = task.recurrenceId
    // Drop the rule with it when nothing else refers to it; an orphaned rule in
    // storage is invisible weight that nothing will ever clean up.
    const orphaned = this.state.tasks.every((t) => t.id === id || t.recurrenceId !== ruleId)
    this.commit(
      {
        ...this.state,
        tasks: this.state.tasks.map((t) => (t.id === id ? { ...t, recurrenceId: null } : t)),
        recurrences: orphaned
          ? this.state.recurrences.filter((r) => r.id !== ruleId)
          : this.state.recurrences,
      },
      `Stopped repeating "${task.title}"`,
    )
  }

  move(id: string, direction: -1 | 1): void {
    const tasks = reorder(this.state.tasks, id, direction)
    if (tasks === this.state.tasks) return
    this.commit({ ...this.state, tasks })
  }
}
