/**
 * Empty states.
 *
 * An empty Today is the goal state of this app, not an error condition, so it
 * gets the most considered screen in the product rather than the words "No
 * tasks" in grey. The surface behind it goes still at the same moment (Phase 7);
 * this is the half of that moment that can be read.
 *
 * A first run is a different situation from a cleared list and says so: one
 * needs teaching, the other needs to be left alone.
 */
import { el } from './dom.ts'
import type { State } from '../lib/types.ts'
import type { View } from '../lib/views.ts'

export type EmptyKind = 'first-run' | 'cleared' | 'nothing-scheduled' | 'empty-project' | 'empty-tag'

export function emptyKindFor(view: View, state: State): EmptyKind {
  const hasAnyTask = state.tasks.some((t) => !t.done)
  switch (view.kind) {
    case 'today':
      return hasAnyTask || state.tasks.length > 0 ? 'cleared' : 'first-run'
    case 'upcoming':
      return state.tasks.length === 0 ? 'first-run' : 'nothing-scheduled'
    case 'all':
      return state.tasks.length === 0 ? 'first-run' : 'cleared'
    case 'project':
      return 'empty-project'
    case 'tag':
      return 'empty-tag'
    case 'calendar':
      return 'nothing-scheduled'
  }
}

const EXAMPLES = [
  ['essay tomorrow !! #uni', 'due tomorrow, high priority, filed under a project'],
  ['standup every weekday at 9am', 'a repeating task with a time'],
  ['renew passport 23 dec @admin', 'a date and a tag'],
]

export function renderEmpty(kind: EmptyKind, state: State, view: View): HTMLElement {
  if (kind === 'first-run') {
    return el('div', { class: 'empty empty-first-run' }, [
      el('h2', {}, ['Nothing here yet']),
      el('p', {}, [
        'Add your first task above. The background reads your backlog: it stays flat and cool while there is little on, and gains movement as work builds up.',
      ]),
      el('ul', { class: 'examples' },
        EXAMPLES.map(([line, gloss]) =>
          el('li', {}, [el('code', {}, [line!]), el('span', { class: 'gloss' }, [gloss!])]),
        ),
      ),
    ])
  }

  if (kind === 'cleared') {
    const remaining = state.tasks.filter((t) => !t.done && t.parentId === null).length
    return el('div', { class: 'empty empty-cleared' }, [
      el('div', { class: 'stillness', 'aria-hidden': 'true' }),
      el('h2', {}, [view.kind === 'today' ? 'Nothing left today' : 'All clear']),
      el('p', {}, [
        remaining === 0
          ? 'Your list is empty and the surface has gone still.'
          : `Nothing is due. ${remaining} ${remaining === 1 ? 'task is' : 'tasks are'} waiting further out.`,
      ]),
    ])
  }

  if (kind === 'nothing-scheduled') {
    return el('div', { class: 'empty' }, [
      el('h2', {}, ['Nothing scheduled']),
      el('p', {}, ['Tasks with a date in the future will appear here.']),
    ])
  }

  if (kind === 'empty-project') {
    return el('div', { class: 'empty' }, [
      el('h2', {}, ['This project is empty']),
      el('p', {}, ['Add a task above, or type #project in the quick add to file one here.']),
    ])
  }

  return el('div', { class: 'empty' }, [
    el('h2', {}, ['Nothing tagged']),
    el('p', {}, ['Tag a task with @name in the quick add and it will show up here.']),
  ])
}
