/**
 * Task detail.
 *
 * A modal `<dialog>`: title, notes, date and optional time, priority, project,
 * tags, subtasks, and whatever recurrence the task carries.
 *
 * Two decisions shape the whole module.
 *
 * **It saves as you go.** There is no OK button, because there is no server and
 * nothing to fail: a field commits on `change` — that is, when you leave it, or
 * press Enter — and the list behind the dialog updates at the same moment.
 * Committing per keystroke instead would flood the undo stack and rewrite the
 * row under the pointer thirty times a sentence.
 *
 * It follows that **every way out of this dialog is a dismiss, not a cancel**:
 * the close button, Done, Escape and a backdrop click all do exactly the same
 * thing, and none of them discards anything. A field typed into but not yet
 * left is flushed on the way out (see `pending`), so the one case where a
 * save-as-you-go dialog could still lose a word — Escape with the caret mid
 * word — cannot. Nothing here needs a "discard changes?" prompt, because there
 * are never unsaved changes to discard; the footer says so, since a user who
 * expects Escape to cancel would otherwise have to find that out by losing
 * something.
 *
 * **It reconciles rather than rebuilds.** The dialog is re-rendered from the
 * store on every change, including its own, so the subtask rows are keyed and
 * mutated in place and no input is ever written to while it has focus. A
 * dialog that blew its own fields away mid-word would be unusable.
 */
import { ask, plural } from './ask.ts'
import { append, el, reconcile, restoreFocus, setAttr, setClass, setText } from './dom.ts'
import { icon } from './icons.ts'
import { RecurrenceEditor } from './recurrence.ts'
import { Store } from './store.ts'
import type { EditScope } from './store.ts'
import { childrenOf, shouldPromptToCloseParent, subtaskProgress } from '../lib/tasks.ts'
import { formatLongDate } from '../lib/dates.ts'
import { describeRule, seriesProgress } from '../lib/series.ts'
import { dueLabel } from '../lib/views.ts'
import type { ISODate, Priority, State, Task } from '../lib/types.ts'

const SCOPE_WORDS: Record<EditScope, string> = {
  occurrence: 'this occurrence only',
  future: 'this and all future',
  series: 'the whole series',
}

const PRIORITIES: { value: Priority; label: string; mark: string }[] = [
  { value: 'none', label: 'None', mark: '—' },
  { value: 'low', label: 'Low', mark: '·' },
  { value: 'medium', label: 'Medium', mark: '!' },
  { value: 'high', label: 'High', mark: '!!' },
  { value: 'urgent', label: 'Urgent', mark: '!!!' },
]

type SubRow = {
  li: HTMLLIElement
  check: HTMLButtonElement
  title: HTMLInputElement
  remove: HTMLButtonElement
  id: string
}

export type DetailHandlers = {
  announce: (message: string) => void
  /** Fired when a subtask is ticked, so the surface ripples from it like any other. */
  ripple: (origin: { x: number; y: number }) => void
}

export class TaskDetail {
  readonly root: HTMLDialogElement

  private readonly store: Store
  private readonly handlers: DetailHandlers

  private taskId: string | null = null
  private returnFocus: HTMLElement | null = null
  /** The close-the-parent prompt, waved away for this visit. */
  private promptDismissed = false
  /**
   * How far edits made in this visit reach into a repeating series.
   *
   * Null until the first edit, which is when the question gets asked — asking
   * on open would interrupt someone who only came to read, and asking per
   * field would ask five times to change a title, a date and a priority. Once
   * answered it holds for the rest of the visit and is shown in the repeat
   * section with a way to change it, so the answer is never invisible.
   */
  private scope: EditScope | null = null
  /** In flight while the scope question is up, so a burst of edits asks once. */
  private scopeAsk: Promise<EditScope | null> | null = null
  /**
   * The commit for a field that has been typed into but not yet left.
   *
   * Escape is a *dismiss*, not a cancel — this dialog saves as you go, so
   * there is no draft to throw away and nothing to warn about. But `change`
   * only fires when a field is left, and Escape closes the dialog out from
   * under whatever field has focus. Rather than depend on the browser firing
   * blur-then-change in that order on close, the half-typed edit is recorded
   * here on `input` and flushed explicitly on the way out.
   */
  private pending: (() => void) | null = null

  private readonly title: HTMLInputElement
  private readonly notes: HTMLTextAreaElement
  private readonly due: HTMLInputElement
  private readonly dueHint: HTMLElement
  private readonly time: HTMLInputElement
  private readonly priority: HTMLElement
  private readonly priorityInputs = new Map<Priority, HTMLInputElement>()
  private readonly project: HTMLSelectElement
  private readonly tagList: HTMLElement
  private readonly newTag: HTMLInputElement
  private readonly repeatRow: HTMLElement
  private readonly repeatText: HTMLElement
  private readonly repeatProgress: HTMLElement
  private readonly repeatEdit: HTMLButtonElement
  private readonly repeatSkip: HTMLButtonElement
  private readonly repeatStop: HTMLButtonElement
  private readonly scopeNote: HTMLElement
  private readonly scopeText: HTMLElement
  private readonly editor: RecurrenceEditor
  private readonly body: HTMLElement
  private readonly scheduling: HTMLElement
  private readonly filing: HTMLElement
  private readonly subtaskSection: HTMLElement
  private readonly subtaskProgressText: HTMLElement
  private readonly subtaskList: HTMLUListElement
  private readonly newSubtask: HTMLInputElement
  private readonly parentPrompt: HTMLElement
  private readonly rows = new Map<string, SubRow>()

  constructor(store: Store, handlers: DetailHandlers) {
    this.store = store
    this.handlers = handlers

    this.title = el('input', {
      class: 'detail-title',
      type: 'text',
      id: 'detail-title',
      autocomplete: 'off',
    })
    this.notes = el('textarea', { class: 'detail-notes', id: 'detail-notes', rows: 3 })
    this.due = el('input', { class: 'detail-date', type: 'date', id: 'detail-due' })
    this.dueHint = el('span', { class: 'field-hint' })
    this.time = el('input', { class: 'detail-time', type: 'time', id: 'detail-time' })
    this.priority = el('div', { class: 'priority-set' })
    this.project = el('select', { class: 'detail-select', id: 'detail-project' })
    this.tagList = el('div', { class: 'tag-set' })
    this.newTag = el('input', {
      class: 'detail-inline-input',
      type: 'text',
      id: 'detail-new-tag',
      autocomplete: 'off',
      placeholder: 'New tag',
    })
    this.repeatText = el('span', { class: 'repeat-text' })
    this.repeatProgress = el('span', { class: 'repeat-progress' })
    this.scopeText = el('span', {})
    this.editor = new RecurrenceEditor()
    this.subtaskProgressText = el('span', { class: 'subtask-progress' })
    this.subtaskList = el('ul', { class: 'subtask-list' })
    this.newSubtask = el('input', {
      class: 'detail-inline-input',
      type: 'text',
      id: 'detail-new-subtask',
      autocomplete: 'off',
      placeholder: 'Add a subtask',
    })
    this.parentPrompt = el('div', { class: 'parent-prompt', role: 'status' })
    this.parentPrompt.hidden = true

    // ---- priority --------------------------------------------------------

    for (const option of PRIORITIES) {
      const input = el('input', {
        class: 'sr-only priority-input',
        type: 'radio',
        name: 'detail-priority',
        id: `detail-priority-${option.value}`,
        value: option.value,
      })
      input.addEventListener('change', () => {
        if (input.checked) this.patch({ priority: option.value }, `Priority: ${option.label}`)
      })
      this.priorityInputs.set(option.value, input)
      this.priority.append(
        input,
        el('label', { class: 'priority-option', for: `detail-priority-${option.value}` }, [
          el('span', { class: 'priority-mark', 'aria-hidden': 'true' }, [option.mark]),
          option.label,
        ]),
      )
    }

    // ---- committing ------------------------------------------------------

    this.bindCommit(this.title, () => {
      const value = this.title.value.trim()
      if (value === '') {
        // An untitled task is not a task. Put the old one back rather than
        // letting the row become a blank line in the list.
        this.title.value = this.task()?.title ?? ''
        return
      }
      this.patch({ title: value }, 'Renamed task')
    })
    this.bindCommit(this.notes, () => this.patch({ notes: this.notes.value }, 'Edited notes'))
    this.bindCommit(this.due, () =>
      this.patch({ due: this.due.value === '' ? null : this.due.value }, 'Changed the date'),
    )
    this.bindCommit(this.time, () =>
      this.patch({ dueTime: this.time.value === '' ? null : this.time.value }, 'Changed the time'),
    )
    // A select has no half-typed state: `change` is the only thing it ever has
    // to say, so there is nothing to flush.
    this.project.addEventListener('change', () =>
      this.patch({ projectId: this.project.value === '' ? null : this.project.value }, 'Refiled'),
    )

    // ---- structure -------------------------------------------------------

    const close = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close task' }, [
      icon('close'),
    ])
    close.addEventListener('click', () => this.close())

    const remove = el('button', { class: 'text-button is-danger', type: 'button' }, [
      icon('trash'),
      'Delete task',
    ])
    remove.addEventListener('click', () => void this.confirmDelete())

    const doneButton = el('button', { class: 'text-button is-primary', type: 'button' }, ['Done'])
    doneButton.addEventListener('click', () => this.close())

    this.repeatStop = el('button', { class: 'text-button', type: 'button' }, ['Stop repeating'])
    this.repeatStop.addEventListener('click', () => this.stopRepeating())

    this.repeatEdit = el('button', { class: 'text-button', type: 'button' }, ['Edit repeat'])
    this.repeatEdit.addEventListener('click', () => void this.editRepeat())

    this.repeatSkip = el('button', { class: 'text-button', type: 'button' }, ['Skip this one'])
    this.repeatSkip.addEventListener('click', () => this.skipOccurrence())

    const changeScope = el('button', { class: 'link-button', type: 'button' }, ['Change'])
    changeScope.addEventListener('click', () => {
      this.scope = null
      const id = this.taskId
      if (id !== null) void this.resolveScope(id)
      this.renderScopeNote()
    })
    this.scopeNote = el('p', { class: 'scope-note', role: 'status' }, [this.scopeText, changeScope])
    this.scopeNote.hidden = true

    this.repeatRow = el('div', { class: 'field field-repeat' }, [
      el('span', { class: 'field-label' }, ['Repeats']),
      el('div', { class: 'repeat-body' }, [icon('repeat'), this.repeatText, this.repeatProgress]),
      el('div', { class: 'repeat-buttons' }, [this.repeatEdit, this.repeatSkip, this.repeatStop]),
      this.scopeNote,
    ])

    const addTag = el('button', { class: 'inline-add', type: 'button', 'aria-label': 'Add tag' }, [
      icon('plus'),
    ])
    addTag.addEventListener('click', () => this.commitNewTag())
    this.newTag.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      this.commitNewTag()
    })

    const addSubtask = el('button', { class: 'inline-add', type: 'button', 'aria-label': 'Add subtask' }, [
      icon('plus'),
    ])
    addSubtask.addEventListener('click', () => this.commitNewSubtask())
    this.newSubtask.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      this.commitNewSubtask()
    })

    this.scheduling = el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'detail-due' }, ['Due']),
        this.due,
        this.dueHint,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'detail-time' }, ['Time']),
        this.time,
      ]),
    ])

    this.filing = el('div', {}, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'detail-project' }, ['Project']),
        this.project,
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', id: 'detail-tags-label' }, ['Tags']),
        el('div', { role: 'group', 'aria-labelledby': 'detail-tags-label' }, [this.tagList]),
        el('div', { class: 'inline-form' }, [
          el('label', { class: 'sr-only', for: 'detail-new-tag' }, ['New tag name']),
          this.newTag,
          addTag,
        ]),
      ]),
      this.repeatRow,
    ])

    this.subtaskSection = el('section', { class: 'subtasks', 'aria-labelledby': 'detail-subtasks' }, [
      el('h3', { class: 'field-label', id: 'detail-subtasks' }, [
        'Subtasks ',
        this.subtaskProgressText,
      ]),
      this.subtaskList,
      this.parentPrompt,
      el('div', { class: 'inline-form' }, [
        el('label', { class: 'sr-only', for: 'detail-new-subtask' }, ['New subtask']),
        this.newSubtask,
        addSubtask,
      ]),
    ])

    this.body = el('div', { class: 'detail-body' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'detail-notes' }, ['Notes']),
        this.notes,
      ]),
      this.scheduling,
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', id: 'detail-priority-label' }, ['Priority']),
        el(
          'div',
          { role: 'radiogroup', 'aria-labelledby': 'detail-priority-label', class: 'priority-wrap' },
          [this.priority],
        ),
      ]),
      this.filing,
      this.subtaskSection,
    ])

    this.root = el('dialog', { class: 'detail glass', 'aria-labelledby': 'detail-heading' }, [
      el('div', { class: 'detail-head' }, [
        el('h2', { class: 'sr-only', id: 'detail-heading' }, ['Task detail']),
        el('label', { class: 'sr-only', for: 'detail-title' }, ['Task title']),
        this.title,
        close,
      ]),
      this.body,
      // The editor is a modal of its own. Living in this dialog's subtree keeps
      // it out of the app's layout code; the top layer puts it above this one
      // regardless of where in the document it sits.
      this.editor.root,
      el('div', { class: 'detail-foot' }, [
        remove,
        // Escape dismisses without discarding, which is only obvious once you
        // know the dialog saves as it goes. Saying it costs one line and stops
        // anyone hesitating over whether closing will cost them the edit.
        el('span', { class: 'detail-hint' }, ['Changes save automatically']),
        doneButton,
      ]),
    ])

    // Escape and the backdrop only reach us as `close`, so that has to be
    // handled — but `close()` below does the same work directly rather than
    // firing the dialog and trusting one event to finish the job.
    this.root.addEventListener('close', () => this.teardown())
  }

  /**
   * Wire a field so its edit survives every way out of the dialog: `change`
   * for the ordinary case, and `pending` for the one where the dialog closes
   * while the caret is still in it.
   */
  private bindCommit(field: HTMLInputElement | HTMLTextAreaElement, commit: () => void): void {
    field.addEventListener('input', () => {
      this.pending = commit
    })
    field.addEventListener('change', () => {
      this.pending = null
      commit()
    })
  }

  /** Run the outstanding edit, if there is one. Safe to call repeatedly. */
  private flush(): void {
    const pending = this.pending
    this.pending = null
    pending?.()
  }

  /** Idempotent: whichever of the two paths gets here first does the work. */
  private teardown(): void {
    if (this.taskId === null && this.returnFocus === null) return

    // Before the id goes: the outstanding edit still needs it to know which
    // task it is patching.
    this.flush()

    // Clearing the id is what stops a stale render writing into a closed dialog.
    this.taskId = null
    const focus = this.returnFocus
    this.returnFocus = null

    // The row that opened this dialog may not exist any more — the edit just
    // made can have completed the task, or moved it out of the current view.
    // The heading is the app's standing "you are here" target, the same one
    // hash routing focuses; quick add is the last resort because it is the one
    // control that is on screen in every view, including an empty one.
    restoreFocus(
      focus,
      () => document.querySelector<HTMLElement>('.view-title'),
      () => document.querySelector<HTMLElement>('.quick-add-input'),
    )
  }

  get isOpen(): boolean {
    return this.taskId !== null && this.root.open
  }

  open(taskId: string): void {
    this.taskId = taskId
    this.promptDismissed = false
    this.scope = null
    this.scopeAsk = null
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.sync(this.store.getState(), this.store.getToday())
    this.root.showModal()
    // The dialog is one long-lived node, so without this a task opens at
    // whatever scroll position the last one was left at.
    this.body.scrollTop = 0
    this.title.focus()
    this.title.setSelectionRange(this.title.value.length, this.title.value.length)
  }

  close(): void {
    if (this.root.open) this.root.close()
    this.teardown()
  }

  private task(): Task | undefined {
    if (this.taskId === null) return undefined
    return this.store.getState().tasks.find((t) => t.id === this.taskId)
  }

  /**
   * Commit an edit.
   *
   * For an ordinary task this is `updateTask` and nothing more. For a repeating
   * one it has to know how far the edit reaches, which is a question only the
   * user can answer — so the first edit of the visit asks, and the answer
   * governs the rest of it.
   */
  private patch(fields: Partial<Task>, label: string): void {
    const id = this.taskId
    if (id === null) return
    const task = this.store.getState().tasks.find((t) => t.id === id)
    if (!task || !this.store.ruleFor(task)) {
      this.store.updateTask(id, fields, label)
      return
    }
    void this.patchScoped(id, fields, label)
  }

  private async patchScoped(id: string, fields: Partial<Task>, label: string): Promise<void> {
    const scope = await this.resolveScope(id)
    if (scope === null) {
      // Declining the question declines the edit. Re-reading from the store
      // puts the field back to what it actually says.
      this.sync(this.store.getState(), this.store.getToday())
      return
    }

    const landed = this.store.applyScopedPatch(id, fields, scope, label)
    if (landed === id) return

    // The occurrence was lifted out of the series into a task of its own, and
    // that new task is the one the edit is on — so the dialog follows it rather
    // than leaving the user editing the row they thought they had just changed.
    this.handlers.announce('Lifted this occurrence out of the repeat')
    if (this.taskId !== id) return
    this.taskId = landed
    // It no longer repeats, so there is nothing left to scope.
    this.scope = 'series'
    this.renderScopeNote()
    this.sync(this.store.getState(), this.store.getToday())
  }

  /**
   * Ask how far an edit reaches, once per visit, and remember the answer.
   *
   * Concurrent edits — a title flushed on the way out while a date change is
   * still waiting — share the one question rather than stacking dialogs.
   */
  private async resolveScope(id: string): Promise<EditScope | null> {
    if (this.scope !== null) return this.scope
    if (this.scopeAsk) return this.scopeAsk

    const task = this.store.getState().tasks.find((t) => t.id === id)
    const occurrence = task ? this.store.occurrenceFor(task) : null
    const when = occurrence ? formatLongDate(occurrence.date, this.store.getToday()) : 'this date'

    this.scopeAsk = ask<EditScope>({
      title: 'This task repeats.',
      message: 'How far should this change reach?',
      choices: [
        {
          value: 'occurrence',
          label: 'Just this occurrence',
          detail: `${when} becomes a task of its own; the repeat carries on unchanged`,
        },
        {
          value: 'future',
          label: 'This and all future',
          detail: `Splits the repeat in two at ${when}, leaving everything before it as it was`,
        },
        {
          value: 'series',
          label: 'The whole series',
          detail: 'Changes the repeating task itself, every occurrence of it',
          preferred: true,
        },
      ],
      // The detail dialog is still modal underneath, so a fallback outside it
      // would be inert; and it may itself have closed, which is why the view
      // heading is behind it.
      focusFallbacks: [
        () => this.root.querySelector<HTMLElement>('.detail-title'),
        () => document.querySelector<HTMLElement>('.view-title'),
      ],
    }).then((answer) => {
      this.scopeAsk = null
      if (answer !== null) {
        this.scope = answer
        this.renderScopeNote()
      }
      return answer
    })

    return this.scopeAsk
  }

  private renderScopeNote(): void {
    const task = this.task()
    const show = this.scope !== null && task !== undefined && this.store.ruleFor(task) !== undefined
    this.scopeNote.hidden = !show
    if (show && this.scope !== null) {
      setText(this.scopeText, `Edits apply to ${SCOPE_WORDS[this.scope]}. `)
    }
  }

  // ---- rendering ---------------------------------------------------------

  /** Re-read the task from the store. Called from the app's render pass. */
  sync(state: State, today: ISODate): void {
    if (this.taskId === null) return
    const task = state.tasks.find((t) => t.id === this.taskId)
    if (!task) {
      // Deleted out from under us — by this dialog, or by a project deletion.
      this.close()
      return
    }

    this.setValue(this.title, task.title)
    this.setValue(this.notes, task.notes)

    // A subtask is a checklist item: it has a title and a tick, and nothing
    // else. Hiding the rest here is the visible half of the rule that
    // `lib/tasks.ts` enforces in state.
    const isSubtask = task.parentId !== null
    this.scheduling.hidden = isSubtask
    this.filing.hidden = isSubtask
    this.subtaskSection.hidden = isSubtask
    if (isSubtask) return

    this.setValue(this.due, task.due ?? '')
    const relative = dueLabel(task.due, today)
    setText(this.dueHint, relative ?? '')
    setClass(this.dueHint, 'is-overdue', task.due !== null && task.due < today)
    this.setValue(this.time, task.dueTime ?? '')

    const priorityInput = this.priorityInputs.get(task.priority)
    if (priorityInput && !priorityInput.checked) priorityInput.checked = true

    this.renderProjects(state, task)
    this.renderTags(state, task)
    this.renderRepeat(state, task)
    this.renderSubtasks(state, task)
  }

  /** Never overwrite a field the user is currently typing into. */
  private setValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (document.activeElement === field) return
    if (field.value !== value) field.value = value
  }

  private renderProjects(state: State, task: Task): void {
    const projects = state.projects
      .filter((p) => !p.archived || p.id === task.projectId)
      .sort((a, b) => a.order - b.order)

    const signature = projects.map((p) => `${p.id}:${p.name}:${p.archived}`).join('|')
    if (this.project.dataset.signature !== signature) {
      this.project.dataset.signature = signature
      this.project.replaceChildren(
        el('option', { value: '' }, ['No project']),
        // An archived project stays selectable while this task is filed under
        // it, so opening an old task does not silently unfile it.
        ...projects.map((p) =>
          el('option', { value: p.id }, [p.archived ? `${p.name} (archived)` : p.name]),
        ),
      )
    }
    const wanted = task.projectId ?? ''
    if (this.project.value !== wanted) this.project.value = wanted
  }

  private renderTags(state: State, task: Task): void {
    const tags = state.tags.filter((t) => !t.archived || task.tagIds.includes(t.id))

    const boxes = tags.map((tag) => {
      const id = `detail-tag-${tag.id}`
      const input = el('input', { class: 'sr-only tag-input', type: 'checkbox', id })
      input.checked = task.tagIds.includes(tag.id)
      input.addEventListener('change', () => {
        const current = this.task()
        if (!current) return
        const next = input.checked
          ? [...current.tagIds, tag.id]
          : current.tagIds.filter((t) => t !== tag.id)
        this.patch({ tagIds: next }, input.checked ? `Tagged @${tag.name}` : `Untagged @${tag.name}`)
      })
      return el('span', { class: 'tag-toggle', style: `--chip: var(--c-${tag.colorToken})` }, [
        input,
        el('label', { class: 'tag-label', for: id }, [
          `@${tag.name}`,
          tag.archived ? el('span', { class: 'sr-only' }, [' (archived)']) : null,
        ]),
      ])
    })

    if (boxes.length === 0) {
      reconcile(this.tagList, [el('span', { class: 'field-hint' }, ['No tags yet.'])])
      return
    }
    // Checkbox state lives on nodes rebuilt each pass, so this list is replaced
    // rather than reconciled; it is short, and it is not what holds focus.
    this.tagList.replaceChildren(...boxes)
  }

  /**
   * The repeat section: the rule in words, where you are in it, and the three
   * things you can do to it.
   *
   * The position — "3 of 10 scheduled" — is not decoration. A skipped
   * occurrence still burns one of a counted rule's occurrences, so a task that
   * only ever said "repeats" would quietly lose one every time somebody skipped
   * a week, with nothing on screen to notice it by.
   */
  private renderRepeat(_state: State, task: Task): void {
    const rule = this.store.ruleFor(task)
    const repeats = rule !== undefined

    setText(this.repeatEdit, repeats ? 'Edit repeat' : 'Add a repeat')
    this.repeatSkip.hidden = !repeats
    this.repeatStop.hidden = !repeats
    setAttr(this.repeatEdit, 'aria-label', `${repeats ? 'Edit' : 'Add'} repeat: ${task.title}`)

    if (!rule) {
      setText(this.repeatText, 'Does not repeat')
      setText(this.repeatProgress, '')
      this.renderScopeNote()
      return
    }

    setText(this.repeatText, describeRule(rule))

    const occurrence = this.store.occurrenceFor(task)
    const progress = seriesProgress(rule, occurrence)
    setText(this.repeatProgress, progress ? `${progress.index} of ${progress.total} scheduled` : '')
    setAttr(
      this.repeatSkip,
      'aria-label',
      occurrence
        ? `Skip ${formatLongDate(occurrence.date, this.store.getToday())}: ${task.title}`
        : `Skip this occurrence: ${task.title}`,
    )
    this.renderScopeNote()
  }

  // ---- repeat actions ----------------------------------------------------

  /**
   * Open the editor and do whatever it comes back with.
   *
   * Changing an existing rule asks for scope first — "this and all future"
   * splits it, "the whole series" rewrites it — and there is no "just this
   * occurrence" here, because a rule that applies to one occurrence is not a
   * rule; that is what Skip and a moved date are for.
   */
  private async editRepeat(): Promise<void> {
    const id = this.taskId
    const task = this.task()
    if (id === null || !task) return
    const existing = this.store.ruleFor(task) ?? null

    const result = await this.editor.open({
      rule: existing,
      today: this.store.getToday(),
      due: task.due,
      weekStart: this.store.getState().settings.weekStartsOn,
      focusFallbacks: [() => this.root.querySelector<HTMLElement>('.field-repeat .text-button')],
    })
    if (result === null) return
    if (result === 'remove') {
      this.stopRepeating()
      return
    }

    if (existing === null) {
      this.store.setRecurrence(id, result)
      this.handlers.announce(`Repeats ${describeRule({ ...result, id: 'x', exceptions: [] })}`)
      return
    }

    const scope = await this.askRuleScope()
    if (scope === null) return
    this.store.setRecurrence(id, result, scope)
    this.handlers.announce(
      scope === 'future' ? 'Changed this and all future occurrences' : 'Changed the whole series',
    )
  }

  /** The two-way version of the scope question: a rule change cannot be per-occurrence. */
  private async askRuleScope(): Promise<EditScope | null> {
    const task = this.task()
    const occurrence = task ? this.store.occurrenceFor(task) : null
    const when = occurrence ? formatLongDate(occurrence.date, this.store.getToday()) : 'here'

    return ask<EditScope>({
      title: 'This task already repeats.',
      message: 'Which occurrences should the new rule cover?',
      choices: [
        {
          value: 'future',
          label: 'This and all future',
          detail: `The old rule ends the day before ${when} and keeps what was already done`,
        },
        {
          value: 'series',
          label: 'The whole series',
          detail: 'Replaces the rule outright, from the day it started',
          preferred: true,
        },
      ],
      focusFallbacks: [() => this.root.querySelector<HTMLElement>('.detail-title')],
    })
  }

  /** Wave one occurrence away without doing it. The rule is untouched. */
  private skipOccurrence(): void {
    const id = this.taskId
    const task = this.task()
    if (id === null || !task) return
    const occurrence = this.store.occurrenceFor(task)
    if (!occurrence) return

    const result = this.store.skipOccurrence(id)
    const when = formatLongDate(occurrence.date, this.store.getToday())
    this.handlers.announce(
      result?.advancedTo
        ? `Skipped ${when}. Next on ${formatLongDate(result.advancedTo, this.store.getToday())}.`
        : `Skipped ${when}. That was the last one.`,
    )
  }

  private stopRepeating(): void {
    const id = this.taskId
    if (id === null) return
    this.store.clearRecurrence(id)
    this.scope = null
    this.renderScopeNote()
    this.handlers.announce('This task no longer repeats')
  }

  private renderSubtasks(state: State, task: Task): void {
    const children = childrenOf(state, task.id).sort((a, b) => a.order - b.order)
    const progress = subtaskProgress(state, task.id)

    setText(
      this.subtaskProgressText,
      progress.total === 0 ? '' : `${progress.done}/${progress.total}`,
    )

    reconcile(this.subtaskList, children.map((child) => this.subRow(child).li))
    for (const [id, row] of this.rows) {
      if (!row.li.isConnected) this.rows.delete(id)
    }

    const prompt = shouldPromptToCloseParent(state, task.id)
    if (!prompt) this.promptDismissed = false
    this.renderParentPrompt(prompt && !this.promptDismissed, task)
  }

  /**
   * The quiet prompt. Completing the last subtask is strong evidence the task
   * is finished but it is not the same claim, so this offers and waits: nothing
   * closes the parent except the user saying so.
   */
  private renderParentPrompt(show: boolean, task: Task): void {
    this.parentPrompt.hidden = !show
    if (!show) {
      this.parentPrompt.replaceChildren()
      return
    }
    if (this.parentPrompt.childElementCount > 0) return

    const yes = el('button', { class: 'text-button is-primary', type: 'button' }, ['Complete task'])
    yes.addEventListener('click', () => {
      const id = this.taskId
      if (!id) return
      this.store.setDone(id, true)
      this.handlers.announce(`Completed ${task.title}`)
      this.close()
    })

    const no = el('button', { class: 'text-button', type: 'button' }, ['Not yet'])
    no.addEventListener('click', () => {
      this.promptDismissed = true
      this.renderParentPrompt(false, task)
      this.newSubtask.focus()
    })

    append(this.parentPrompt, [
      el('span', {}, ['Every subtask is done. Close this task?']),
      el('div', { class: 'prompt-actions' }, [yes, no]),
    ])
  }

  private subRow(child: Task): SubRow {
    const existing = this.rows.get(child.id)
    if (existing) {
      this.updateSubRow(existing, child)
      return existing
    }

    const check = el('button', { class: 'check check-sm', type: 'button' }, [icon('check', 'check-mark')])
    const title = el('input', { class: 'subtask-title', type: 'text', autocomplete: 'off' })
    const remove = el('button', { class: 'icon-button', type: 'button' }, [icon('close')])
    const li = el('li', { class: 'subtask', 'data-id': child.id }, [check, title, remove])

    const row: SubRow = { li, check, title, remove, id: child.id }

    check.addEventListener('click', () => {
      const current = this.store.getState().tasks.find((t) => t.id === child.id)
      if (!current) return
      if (!current.done) {
        const box = check.getBoundingClientRect()
        this.handlers.ripple({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
      }
      this.store.setDone(child.id, !current.done)
    })

    this.bindCommit(title, () => {
      const value = title.value.trim()
      if (value === '') {
        title.value = this.store.getState().tasks.find((t) => t.id === child.id)?.title ?? ''
        return
      }
      this.store.updateTask(child.id, { title: value }, 'Renamed subtask')
    })

    remove.addEventListener('click', () => {
      // A subtask cannot itself have children, so there is nothing to ask about.
      this.store.deleteTask(child.id, { subtasks: 'delete' })
      this.handlers.announce(`Deleted subtask ${child.title}`)
      this.newSubtask.focus()
    })

    this.rows.set(child.id, row)
    this.updateSubRow(row, child)
    return row
  }

  private updateSubRow(row: SubRow, child: Task): void {
    this.setValue(row.title, child.title)
    setClass(row.li, 'is-done', child.done)
    setAttr(row.check, 'aria-pressed', child.done ? 'true' : 'false')
    setAttr(row.check, 'aria-label', `${child.done ? 'Reopen' : 'Complete'}: ${child.title}`)
    setAttr(row.title, 'aria-label', `Subtask: ${child.title}`)
    setAttr(row.remove, 'aria-label', `Delete subtask: ${child.title}`)
  }

  // ---- actions -----------------------------------------------------------

  private commitNewTag(): void {
    const name = this.newTag.value.trim()
    const task = this.task()
    if (name === '' || !task) return

    const existing = this.store.getState().tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (!task.tagIds.includes(existing.id)) {
        this.patch({ tagIds: [...task.tagIds, existing.id] }, `Tagged @${existing.name}`)
      }
      this.newTag.value = ''
      this.handlers.announce(`Tagged ${existing.name}`)
      return
    }

    const created = this.store.createTag(name)
    if (!created.ok) {
      this.handlers.announce(created.error.message)
      return
    }
    const tag = created.value.tags[created.value.tags.length - 1]
    if (tag) this.patch({ tagIds: [...task.tagIds, tag.id] }, `Tagged @${tag.name}`)
    this.newTag.value = ''
    this.handlers.announce(`Tagged ${name}`)
  }

  private commitNewSubtask(): void {
    const title = this.newSubtask.value.trim()
    if (title === '' || this.taskId === null) return
    const result = this.store.addSubtask(this.taskId, title)
    if (!result.ok) {
      this.handlers.announce(result.error.message)
      return
    }
    this.newSubtask.value = ''
    this.handlers.announce(`Added subtask ${title}`)
    this.newSubtask.focus()
  }

  /**
   * Deleting a parent asks what to do with the children, and states the count
   * both ways round — the alternative is a yes/no that quietly picks one.
   */
  private async confirmDelete(): Promise<void> {
    const task = this.task()
    if (!task) return
    const children = childrenOf(this.store.getState(), task.id)

    if (children.length === 0) {
      const answer = await ask<'delete'>({
        title: `Delete "${task.title}"?`,
        message: 'This cannot be undone once the undo window has passed.',
        choices: [{ value: 'delete', label: 'Delete task', tone: 'danger' }],
        // Cancelling leaves this dialog open, so the fallback stays inside it.
        focusFallbacks: [() => this.root.querySelector<HTMLElement>('.detail-title')],
      })
      if (answer === null) return
      this.store.deleteTask(task.id, { subtasks: 'delete' })
      this.handlers.announce(`Deleted ${task.title}`)
      this.close()
      return
    }

    const count = plural(children.length, 'subtask')
    const answer = await ask<'delete' | 'promote'>({
      title: `Delete "${task.title}"?`,
      message: `It has ${count}.`,
      choices: [
        {
          value: 'promote',
          label: 'Keep the subtasks',
          detail: `${count} become top-level tasks`,
          preferred: true,
        },
        {
          value: 'delete',
          label: 'Delete the subtasks too',
          detail: `${plural(children.length + 1, 'task')} deleted in total`,
          tone: 'danger',
        },
      ],
      focusFallbacks: [() => this.root.querySelector<HTMLElement>('.detail-title')],
    })
    if (answer === null) return

    this.store.deleteTask(task.id, { subtasks: answer })
    this.handlers.announce(
      answer === 'promote'
        ? `Deleted ${task.title}. ${count} promoted to top level.`
        : `Deleted ${task.title} and ${count}.`,
    )
    this.close()
  }
}
