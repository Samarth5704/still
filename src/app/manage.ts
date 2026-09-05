/**
 * Projects and tags, managed.
 *
 * Create, rename, recolour, archive — and, if you insist, delete.
 *
 * Archiving is the default and the delete dialog says so, because the reason it
 * exists is not tidiness: a task you completed last month is filed under a name,
 * and deleting that name either rewrites your history or leaves a dangling
 * reference. Archiving retires the entry from the sidebar and the pickers while
 * every task that points at it still resolves.
 *
 * Deleting anyway is allowed, and it asks. The question is put in two steps so
 * that each one is a short list of real buttons rather than one dialog holding
 * every project you own: first what happens to the tasks, then — if they are
 * being kept — where they go.
 */
import { ask, plural } from './ask.ts'
import { el, restoreFocus, setClass, setText } from './dom.ts'
import { icon } from './icons.ts'
import { Store } from './store.ts'
import { CATALOG_COLORS, projectUsage, tagUsage } from '../lib/catalog.ts'
import type { Usage } from '../lib/catalog.ts'
import type { Project, State, Tag } from '../lib/types.ts'

type Kind = 'project' | 'tag'

type Entry = { id: string; name: string; colorToken: string; archived: boolean }

type Row = {
  li: HTMLLIElement
  name: HTMLInputElement
  colour: HTMLSelectElement
  swatch: HTMLElement
  archive: HTMLButtonElement
  remove: HTMLButtonElement
  usage: HTMLElement
}

export type ManageHandlers = { announce: (message: string) => void }

export class Manage {
  readonly root: HTMLDialogElement

  private readonly store: Store
  private readonly handlers: ManageHandlers
  private readonly lists: Record<Kind, HTMLUListElement>
  private readonly empties: Record<Kind, HTMLElement>
  private readonly inputs: Record<Kind, HTMLInputElement>
  private readonly errors: Record<Kind, HTMLElement>
  private readonly rows = new Map<string, Row>()
  private returnFocus: HTMLElement | null = null
  /** A rename typed but not yet left. Flushed on the way out; see teardown. */
  private pending: (() => void) | null = null

  constructor(store: Store, handlers: ManageHandlers) {
    this.store = store
    this.handlers = handlers

    this.lists = { project: el('ul', { class: 'manage-list' }), tag: el('ul', { class: 'manage-list' }) }
    this.empties = {
      project: el('p', { class: 'field-hint' }, ['No projects yet. Type #name in the quick add, or add one here.']),
      tag: el('p', { class: 'field-hint' }, ['No tags yet. Type @name in the quick add, or add one here.']),
    }
    this.inputs = {
      project: el('input', { class: 'detail-inline-input', type: 'text', id: 'manage-new-project', autocomplete: 'off', placeholder: 'New project' }),
      tag: el('input', { class: 'detail-inline-input', type: 'text', id: 'manage-new-tag', autocomplete: 'off', placeholder: 'New tag' }),
    }
    this.errors = {
      project: el('p', { class: 'manage-error', role: 'alert' }),
      tag: el('p', { class: 'manage-error', role: 'alert' }),
    }
    this.errors.project.hidden = true
    this.errors.tag.hidden = true

    const close = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close' }, [icon('close')])
    close.addEventListener('click', () => this.close())

    const doneButton = el('button', { class: 'text-button is-primary', type: 'button' }, ['Done'])
    doneButton.addEventListener('click', () => this.close())

    this.root = el('dialog', { class: 'manage glass', 'aria-labelledby': 'manage-heading' }, [
      el('div', { class: 'detail-head' }, [
        el('h2', { class: 'manage-heading', id: 'manage-heading' }, ['Projects and tags']),
        close,
      ]),
      el('div', { class: 'detail-body' }, [
        this.section('project', 'Projects', 'Add project'),
        this.section('tag', 'Tags', 'Add tag'),
      ]),
      el('div', { class: 'detail-foot' }, [doneButton]),
    ])

    // Escape and the backdrop only reach us as `close`; `close()` below does
    // the same work directly, and `teardown` is idempotent so whichever path
    // arrives first is the one that runs.
    this.root.addEventListener('close', () => this.teardown())
  }

  private teardown(): void {
    // A rename left mid-word survives the dismiss, exactly as in task detail.
    const pending = this.pending
    this.pending = null
    pending?.()

    const focus = this.returnFocus
    this.returnFocus = null
    // The trigger is the header button, which nothing in this dialog can
    // destroy — but the fallbacks cost nothing and mean a future caller that
    // opens this from somewhere more fragile is already covered.
    restoreFocus(
      focus,
      () => document.querySelector<HTMLElement>('.header-manage'),
      () => document.querySelector<HTMLElement>('.view-title'),
    )
  }

  private section(kind: Kind, title: string, addLabel: string): HTMLElement {
    const add = el('button', { class: 'inline-add', type: 'button', 'aria-label': addLabel }, [icon('plus')])
    add.addEventListener('click', () => this.create(kind))
    this.inputs[kind].addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      this.create(kind)
    })

    return el('section', { class: 'manage-section' }, [
      el('h3', { class: 'field-label' }, [title]),
      this.empties[kind],
      this.lists[kind],
      this.errors[kind],
      el('div', { class: 'inline-form' }, [
        el('label', { class: 'sr-only', for: this.inputs[kind].id }, [addLabel]),
        this.inputs[kind],
        add,
      ]),
    ])
  }

  open(): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Open first: `sync` ignores a closed dialog, so filling it beforehand
    // would quietly leave every list empty until the next store change.
    this.root.showModal()
    this.sync(this.store.getState())
    this.inputs.project.focus()
  }

  close(): void {
    if (this.root.open) this.root.close()
    this.teardown()
  }

  get isOpen(): boolean {
    return this.root.open
  }

  /** Re-read the catalogues from the store. Called from the app's render pass. */
  sync(state: State): void {
    if (!this.root.open) return
    this.renderList('project', state, state.projects.slice().sort(byArchivedThenOrder))
    this.renderList('tag', state, state.tags.slice().sort(byArchivedThenName))
    for (const [key, row] of this.rows) {
      if (!row.li.isConnected) this.rows.delete(key)
    }
  }

  private renderList(kind: Kind, state: State, entries: Entry[]): void {
    this.empties[kind].hidden = entries.length > 0
    const desired = entries.map((entry) => {
      const row = this.rowFor(kind, entry)
      this.updateRow(row, kind, state, entry)
      return row.li
    })
    // Rows are keyed by id; replaceChildren with the same nodes reorders
    // without recreating them, so an input keeps its focus and its caret.
    this.lists[kind].replaceChildren(...desired)
  }

  private rowFor(kind: Kind, entry: Entry): Row {
    const key = `${kind}:${entry.id}`
    const existing = this.rows.get(key)
    if (existing) return existing

    const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' })
    const colour = el('select', { class: 'colour-select' },
      CATALOG_COLORS.map((c) => el('option', { value: c }, [c[0]!.toUpperCase() + c.slice(1)])),
    )
    const name = el('input', { class: 'manage-name', type: 'text', autocomplete: 'off' })
    const usage = el('span', { class: 'manage-usage' })
    const archive = el('button', { class: 'icon-button', type: 'button' }, [icon('archive')])
    const remove = el('button', { class: 'icon-button is-danger', type: 'button' }, [icon('trash')])

    const li = el('li', { class: 'manage-row' }, [
      el('span', { class: 'swatch-wrap' }, [swatch, colour]),
      el('span', { class: 'manage-body' }, [name, usage]),
      archive,
      remove,
    ])

    const row: Row = { li, name, colour, swatch, archive, remove, usage }

    const commitName = (refocus: boolean): void => {
      const value = name.value.trim()
      const result =
        kind === 'project'
          ? this.store.renameProject(entry.id, value)
          : this.store.renameTag(entry.id, value)
      if (result.ok) {
        this.showError(kind, null)
        return
      }
      this.showError(kind, result.error.message)
      name.value = this.currentName(kind, entry.id) ?? entry.name
      // On the way out there is nothing to send the user back to, and the
      // error message would announce into a dialog that is already gone.
      if (refocus) name.focus()
    }

    // Same bargain as the detail dialog: a rename typed but not yet left is
    // flushed when the dialog closes, so Escape never silently drops it.
    name.addEventListener('input', () => {
      this.pending = () => commitName(false)
    })
    name.addEventListener('change', () => {
      this.pending = null
      commitName(true)
    })

    colour.addEventListener('change', () => {
      if (kind === 'project') this.store.setProjectColor(entry.id, colour.value)
      else this.store.setTagColor(entry.id, colour.value)
    })

    archive.addEventListener('click', () => {
      const archived = !this.isArchived(kind, entry.id)
      if (kind === 'project') this.store.setProjectArchived(entry.id, archived)
      else this.store.setTagArchived(entry.id, archived)
      const label = this.currentName(kind, entry.id) ?? entry.name
      this.handlers.announce(`${archived ? 'Archived' : 'Restored'} ${label}`)
    })

    remove.addEventListener('click', () => void this.confirmDelete(kind, entry.id))

    this.rows.set(key, row)
    return row
  }

  private updateRow(row: Row, kind: Kind, state: State, entry: Entry): void {
    if (document.activeElement !== row.name && row.name.value !== entry.name) {
      row.name.value = entry.name
    }
    if (row.colour.value !== entry.colorToken) row.colour.value = entry.colorToken
    row.swatch.style.setProperty('--chip', `var(--c-${entry.colorToken})`)
    setClass(row.li, 'is-archived', entry.archived)

    const label = kind === 'project' ? entry.name : `@${entry.name}`
    const usage = kind === 'project' ? projectUsage(state, entry.id) : tagUsage(state, entry.id)
    setText(row.usage, describeUsage(usage, entry.archived))

    row.name.setAttribute('aria-label', `${kind === 'project' ? 'Project' : 'Tag'} name: ${entry.name}`)
    row.colour.setAttribute('aria-label', `Colour for ${label}`)
    row.archive.setAttribute('aria-label', `${entry.archived ? 'Restore' : 'Archive'}: ${label}`)
    row.archive.replaceChildren(icon(entry.archived ? 'unarchive' : 'archive'))
    row.remove.setAttribute('aria-label', `Delete: ${label}`)
  }

  private isArchived(kind: Kind, id: string): boolean {
    const state = this.store.getState()
    return kind === 'project'
      ? (state.projects.find((p) => p.id === id)?.archived ?? false)
      : (state.tags.find((t) => t.id === id)?.archived ?? false)
  }

  private currentName(kind: Kind, id: string): string | undefined {
    const state = this.store.getState()
    return kind === 'project'
      ? state.projects.find((p) => p.id === id)?.name
      : state.tags.find((t) => t.id === id)?.name
  }

  private showError(kind: Kind, message: string | null): void {
    setText(this.errors[kind], message ?? '')
    this.errors[kind].hidden = message === null
  }

  private create(kind: Kind): void {
    const input = this.inputs[kind]
    const name = input.value.trim()
    if (name === '') return
    const result = kind === 'project' ? this.store.createProject(name) : this.store.createTag(name)
    if (!result.ok) {
      this.showError(kind, result.error.message)
      return
    }
    this.showError(kind, null)
    input.value = ''
    input.focus()
    this.handlers.announce(`Added ${kind} ${name}`)
  }

  // ---- deletion ----------------------------------------------------------

  private async confirmDelete(kind: Kind, id: string): Promise<void> {
    if (kind === 'project') await this.confirmDeleteProject(id)
    else await this.confirmDeleteTag(id)
  }

  private async confirmDeleteProject(id: string): Promise<void> {
    const state = this.store.getState()
    const project = state.projects.find((p) => p.id === id)
    if (!project) return
    const usage = projectUsage(state, id)

    if (usage.total === 0) {
      const answer = await ask<'delete'>({
        title: `Delete "${project.name}"?`,
        message: 'Nothing is filed under it.',
        choices: [{ value: 'delete', label: 'Delete project', tone: 'danger' }],
        focusFallbacks: [() => this.inputs.project],
      })
      if (answer === null) return
      this.finish(this.store.deleteProject(id, { tasks: 'reassign', to: null }), `Deleted ${project.name}`)
      return
    }

    const tasks = plural(usage.total, 'task')
    const first = await ask<'keep' | 'delete' | 'archive'>({
      title: `Delete "${project.name}"?`,
      message: `${tasks} ${usage.total === 1 ? 'is' : 'are'} filed under it${
        usage.done > 0 ? `, including ${plural(usage.done, 'completed task')}` : ''
      }.`,
      choices: [
        {
          value: 'archive',
          label: 'Archive it instead',
          detail: 'Hidden from the sidebar; the name still resolves on every task',
          preferred: true,
        },
        { value: 'keep', label: 'Delete, keep the tasks', detail: `${tasks} moved elsewhere` },
        {
          value: 'delete',
          label: 'Delete the tasks too',
          detail: `${tasks} deleted, subtasks included`,
          tone: 'danger',
        },
      ],
      focusFallbacks: [() => this.inputs.project],
    })
    if (first === null) return

    if (first === 'archive') {
      this.finish(this.store.setProjectArchived(id, true), `Archived ${project.name}`)
      return
    }

    if (first === 'delete') {
      this.finish(
        this.store.deleteProject(id, { tasks: 'delete' }),
        `Deleted ${project.name} and ${tasks}`,
      )
      return
    }

    const others = this.store.getState().projects.filter((p) => p.id !== id && !p.archived)
    if (others.length === 0) {
      this.finish(
        this.store.deleteProject(id, { tasks: 'reassign', to: null }),
        `Deleted ${project.name}. ${tasks} unfiled.`,
      )
      return
    }

    const target = await ask<string>({
      title: `Where do the ${tasks} go?`,
      choices: [
        { value: '', label: 'No project', detail: `${tasks} left unfiled`, preferred: true },
        ...others.map((p) => ({ value: p.id, label: `Move to ${p.name}` })),
      ],
      focusFallbacks: [() => this.inputs.project],
    })
    if (target === null) return

    const to = target === '' ? null : target
    const where = to === null ? 'unfiled' : `moved to ${others.find((p) => p.id === to)?.name}`
    this.finish(
      this.store.deleteProject(id, { tasks: 'reassign', to }),
      `Deleted ${project.name}. ${tasks} ${where}.`,
    )
  }

  private async confirmDeleteTag(id: string): Promise<void> {
    const state = this.store.getState()
    const tag = state.tags.find((t) => t.id === id)
    if (!tag) return
    const usage = tagUsage(state, id)

    if (usage.total === 0) {
      const answer = await ask<'delete'>({
        title: `Delete "@${tag.name}"?`,
        message: 'Nothing carries it.',
        choices: [{ value: 'delete', label: 'Delete tag', tone: 'danger' }],
        focusFallbacks: [() => this.inputs.tag],
      })
      if (answer === null) return
      this.finish(this.store.deleteTag(id, { tasks: 'untag' }), `Deleted @${tag.name}`)
      return
    }

    const tasks = plural(usage.total, 'task')
    const others = state.tags.filter((t) => t.id !== id && !t.archived)
    const first = await ask<'archive' | 'untag' | 'move'>({
      title: `Delete "@${tag.name}"?`,
      message: `${tasks} ${usage.total === 1 ? 'carries' : 'carry'} it.`,
      choices: [
        {
          value: 'archive',
          label: 'Archive it instead',
          detail: 'Hidden from the sidebar; the name still resolves on every task',
          preferred: true,
        },
        { value: 'untag', label: 'Delete, remove the tag', detail: `${tasks} keep everything else` },
        ...(others.length > 0
          ? [{ value: 'move' as const, label: 'Delete, move to another tag', detail: `${tasks} retagged` }]
          : []),
      ],
      focusFallbacks: [() => this.inputs.tag],
    })
    if (first === null) return

    if (first === 'archive') {
      this.finish(this.store.setTagArchived(id, true), `Archived @${tag.name}`)
      return
    }

    if (first === 'untag') {
      this.finish(
        this.store.deleteTag(id, { tasks: 'untag' }),
        `Deleted @${tag.name}. Removed from ${tasks}.`,
      )
      return
    }

    const target = await ask<string>({
      title: `Which tag replaces @${tag.name}?`,
      choices: others.map((t) => ({ value: t.id, label: `@${t.name}` })),
      focusFallbacks: [() => this.inputs.tag],
    })
    if (target === null) return

    this.finish(
      this.store.deleteTag(id, { tasks: 'reassign', to: target }),
      `Deleted @${tag.name}. ${tasks} moved to @${others.find((t) => t.id === target)?.name}.`,
    )
  }

  private finish(result: { ok: boolean; error?: { message: string } }, message: string): void {
    if (!result.ok) {
      this.handlers.announce(result.error?.message ?? 'That could not be done')
      return
    }
    this.handlers.announce(message)
  }
}

function describeUsage(usage: Usage, archived: boolean): string {
  const parts: string[] = []
  if (usage.total === 0) parts.push('unused')
  else {
    parts.push(plural(usage.open, 'open task'))
    if (usage.done > 0) parts.push(`${usage.done} completed`)
  }
  if (archived) parts.push('archived')
  return parts.join(' · ')
}

const byArchivedThenOrder = (a: Project, b: Project): number =>
  Number(a.archived) - Number(b.archived) || a.order - b.order || a.name.localeCompare(b.name)

const byArchivedThenName = (a: Tag, b: Tag): number =>
  Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name)
