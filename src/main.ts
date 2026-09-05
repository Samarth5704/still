/**
 * The app.
 *
 * Wiring only: the store owns state, `lib/` owns every decision, and the view
 * modules own their nodes. This file connects them and owns the two things
 * nobody else should — the URL and the keyboard.
 *
 * The shader is not here yet. Phase 7 attaches it to the same store and listens
 * for the `still:ripple` events fired below, which is why completions already
 * report where on screen they happened.
 */
import './style.css'

import { Announcer } from './app/announce.ts'
import { Calendar } from './app/calendar.ts'
import { Header, Nav } from './app/chrome.ts'
import { Manage } from './app/manage.ts'
import { QuickAdd } from './app/quickadd.ts'
import { Store } from './app/store.ts'
import { TaskDetail } from './app/detail.ts'
import { TaskList } from './app/tasklist.ts'
import { UndoBar } from './app/undo.ts'
import { emptyKindFor, renderEmpty } from './app/empty.ts'
import { el, query, setText } from './app/dom.ts'
import { formatLongDate } from './lib/dates.ts'
import { formatHash, groupsForView, parseHash, viewCounts, viewTitle } from './lib/views.ts'
import type { View } from './lib/views.ts'
import type { ISODate, State, Task, WeekStart } from './lib/types.ts'

const store = new Store()
let view: View = parseHash(location.hash)

const root = query<HTMLElement>(document, '#app')
const announcer = new Announcer(document.body)

const manage = new Manage(store, { announce: (message) => announcer.say(message) })
const header = new Header(() => manage.open())
const nav = new Nav()
const undoBar = new UndoBar()

/** A completion anywhere reports where on screen it happened; Phase 7 rides on it. */
function ripple(origin: { x: number; y: number }): void {
  window.dispatchEvent(
    new CustomEvent('still:ripple', { detail: { x: origin.x, y: origin.y, strength: 1 } }),
  )
}

const detail = new TaskDetail(store, {
  announce: (message) => announcer.say(message),
  ripple,
})

const heading = el('h1', { class: 'view-title', tabindex: '-1' })
const listHost = el('div', { class: 'list-host' })

const quickAdd = new QuickAdd(
  (parsed) => {
    store.addTask({
      title: parsed.title,
      due: parsed.due,
      dueTime: parsed.dueTime,
      priority: parsed.priority,
      projectName: parsed.projectName,
      tagNames: parsed.tagNames,
      recurrence: parsed.recurrence,
    })
    announcer.say(`Added ${parsed.title}`)
  },
  { today: store.getToday(), weekStart: store.getState().settings.weekStartsOn },
)

type Source = 'list' | 'calendar'

const taskList = new TaskList({
  onToggle: (task, origin) => complete(task, origin),
  onOpen: (task) => detail.open(task.id),
  onMove: (task, direction) => {
    store.move(task.id, direction)
    announcer.say(`Moved ${task.title} ${direction === -1 ? 'up' : 'down'}`)
  },
})

/**
 * The calendar.
 *
 * Its selected day lives in the URL, but a day is a filter rather than a
 * destination, so it is written with `replaceState`: Back should leave the
 * calendar, not walk back through every day someone looked at. That also means
 * no `hashchange`, so no focus move — which is what keeps the arrow keys inside
 * the grid where the user put them.
 */
const calendar = new Calendar({
  onSelectDay: (day) => {
    view = { kind: 'calendar', day }
    history.replaceState(null, '', formatHash(view))
    render()
  },
  onOpenTask: (id) => detail.open(id),
  onToggle: (id, origin) => {
    const task = store.getState().tasks.find((t) => t.id === id)
    if (task) complete(task, origin, 'calendar')
  },
  announce: (message) => announcer.say(message),
})

/**
 * Complete a task: commit immediately so the surface and every count react at
 * once, hold the row on screen for a beat, and offer the change back for eight
 * seconds.
 *
 * A repeating task is the one case where the row does *not* leave. Ticking it
 * finishes one occurrence and the same task reappears on its next date, so
 * animating it out and then putting it back would be a lie about what just
 * happened. The undo message says where it went instead.
 */
function complete(task: Task, origin: { x: number; y: number }, source: Source = 'list'): void {
  if (task.done) return

  // Phase 7 turns this into a ripple from the checkbox. Firing it here keeps
  // the shader out of the list's business entirely.
  ripple(origin)

  let advancedTo: ISODate | null = null
  if (store.ruleFor(task)) {
    advancedTo = store.completeOccurrence(task.id)?.advancedTo ?? null
  } else {
    store.setDone(task.id, true)
  }
  const snapshot = store.peekUndo()

  const undoAction = (): void => {
    // Only a task that actually left has an exit to cancel.
    if (advancedTo === null) taskList.cancelExit(task.id)
    store.undo()
    announcer.say(`Restored ${task.title}`)
  }
  const onExpire = (): void => {
    if (snapshot) store.expireUndo(snapshot)
  }

  if (source !== 'list') {
    // The calendar has no row to animate out and no next row to fall onto: the
    // entry either changes status in place or moves to another day, and the
    // component has already handed focus on. Everything else — the commit, the
    // ripple, the undo window — is identical, which is the point of routing
    // both through here.
    const next = advancedTo === null ? null : formatLongDate(advancedTo, store.getToday())
    announcer.say(next ? `Completed ${task.title}. Next on ${next}.` : `Completed ${task.title}`)
    undoBar.show(
      next ? `Completed "${task.title}" — next on ${next}` : `Completed "${task.title}"`,
      undoAction,
      onExpire,
    )
    return
  }

  if (advancedTo !== null) {
    // The row has not been removed, but the new date can carry it out of this
    // view — ticking today's occurrence of a weekly task moves it to Upcoming.
    // When that happens the focused checkbox goes with it and focus lands on
    // <body>, which is the end of keyboard navigation until the user tabs in
    // from the top of the page.
    if (document.activeElement === null || document.activeElement === document.body) {
      taskList.focusNear(task.id)
    }
    const next = formatLongDate(advancedTo, store.getToday())
    announcer.say(`Completed ${task.title}. Next on ${next}.`)
    undoBar.show(`Completed "${task.title}" — next on ${next}`, undoAction, onExpire)
    return
  }

  taskList.focusNear(task.id)
  taskList.animateOut(task.id, () => render())

  announcer.say(`Completed ${task.title}`)
  undoBar.show(`Completed "${task.title}"`, undoAction, onExpire)
}

function render(): void {
  const state = store.getState()
  const today = store.getToday()
  const pressure = store.getPressure()
  const weekStart = state.settings.weekStartsOn

  header.render(pressure)
  nav.render(state, viewCounts(state, today), view)
  setText(heading, viewTitle(view, state))

  if (view.kind === 'calendar') {
    if (listHost.firstElementChild !== calendar.root) listHost.replaceChildren(calendar.root)
    calendar.render(state, today, weekStart, view.day)
  } else {
    renderList(state, today, weekStart)
  }

  // The dialogs read from the same store as everything else, so a rename in
  // one is visible in the other before the pointer has moved.
  detail.sync(state, today)
  manage.sync(state)

  announcer.summarise(Header.summary(pressure))
  quickAdd.setContext({ today, weekStart })
}

function renderList(state: State, today: ISODate, weekStart: WeekStart): void {
  const groups = groupsForView(state, view, today, weekStart)

  if (groups.length === 0) {
    // Rebuild the empty state only when it is a different one, so clearing your
    // list does not restart its entrance animation on the next render.
    const kind = emptyKindFor(view, state)
    const current = listHost.querySelector<HTMLElement>('.empty')
    if (!current || current.dataset.kind !== kind) {
      const empty = renderEmpty(kind, state, view)
      empty.dataset.kind = kind
      listHost.replaceChildren(empty)
    }
  } else {
    if (listHost.firstElementChild !== taskList.root) listHost.replaceChildren(taskList.root)
    taskList.render(groups, state, today, view)
  }
}

// ---- layout ---------------------------------------------------------------

root.append(
  header.root,
  el('div', { class: 'app-body' }, [
    nav.root,
    el('main', { class: 'app-main' }, [
      quickAdd.root,
      el('div', { class: 'list-frame' }, [heading, listHost]),
    ]),
  ]),
  undoBar.root,
  detail.root,
  manage.root,
)

if (store.readOnly) {
  root.prepend(
    el('div', { class: 'banner', role: 'alert' }, [
      'This data was saved by a newer version of Still. You can read it, but nothing will be saved.',
    ]),
  )
}

// ---- routing --------------------------------------------------------------

function applyHash(): void {
  view = parseHash(location.hash)
  render()
  // Moving focus to the heading is what makes a hash-routed app usable from the
  // keyboard: without it, focus stays on the link and the new list is unreachable.
  heading.focus()
}

window.addEventListener('hashchange', applyHash)

// Give the opening view a canonical URL, so the first thing in history is
// linkable rather than a bare document address.
if (location.hash === '') history.replaceState(null, '', '#/today')

// ---- keyboard -------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  const target = event.target
  const typing =
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

  // A modal owns the keyboard while it is up. Quick add is behind it and
  // unreachable, so stealing the keystroke would only eat it.
  if (detail.isOpen || manage.isOpen) return

  if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
    event.preventDefault()
    quickAdd.focus()
    return
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    if (typing && !undoBar.isActive) return
    if (!undoBar.isActive) return
    event.preventDefault()
    undoBar.fire()
  }
})

// ---- clock ----------------------------------------------------------------

// A tab left open overnight must not keep calling yesterday "today": every due
// label and the whole pressure number depend on it.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) store.refreshToday()
})
window.setInterval(() => store.refreshToday(), 60_000)

window.addEventListener('pagehide', () => store.flush())

// ---- go -------------------------------------------------------------------

store.subscribe(() => render())
store.start()
