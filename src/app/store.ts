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
import type { RecurrenceDraft } from '../lib/parse.ts'
import type {
  ISODate,
  Priority,
  PressureSummary,
  Project,
  Recurrence,
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
      colorToken: PROJECT_COLORS[this.state.projects.length % PROJECT_COLORS.length]!,
      icon: 'circle',
      archived: false,
      order: this.state.projects.length,
    }
    return { state: { ...this.state, projects: [...this.state.projects, project] }, project }
  }

  ensureTag(state: State, name: string): { state: State; tag: Tag } {
    const existing = state.tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) return { state, tag: existing }

    const tag: Tag = {
      id: newId(),
      name,
      colorToken: PROJECT_COLORS[state.tags.length % PROJECT_COLORS.length]!,
    }
    return { state: { ...state, tags: [...state.tags, tag] }, tag }
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

  move(id: string, direction: -1 | 1): void {
    const tasks = reorder(this.state.tasks, id, direction)
    if (tasks === this.state.tasks) return
    this.commit({ ...this.state, tasks })
  }
}

/** Token names resolved to real colours in the stylesheet. */
const PROJECT_COLORS = ['teal', 'indigo', 'amber', 'plum', 'moss', 'clay']
