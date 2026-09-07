/**
 * @vitest-environment happy-dom
 *
 * Regression tests for two defects found by driving the real app in a browser,
 * both of which typecheck, both of which are silent, and neither of which any
 * pure test could have caught — they are defects in the *order* two DOM calls
 * happen in.
 *
 * The rest of the suite runs in a node environment, because `lib/` is pure and
 * a DOM there would only be dead weight. This file opts into one per the
 * docblock above; the environment is a test dependency and ships nowhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Manage } from './manage.ts'
import { Settings } from './settings.ts'
import { Store } from './store.ts'
import { TaskDetail } from './detail.ts'
import { restoreFocus } from './dom.ts'

const silent = { announce: () => {}, ripple: () => {} }

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})

afterEach(() => {
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove()
})

describe('Manage', () => {
  /*
   * The bug: `open()` called `sync()` and then `showModal()`, but `sync()`
   * begins `if (!this.root.open) return` — so the lists were filled *before*
   * the dialog counted as open, the guard threw the work away, and the dialog
   * appeared claiming "No projects yet" over a sidebar listing four of them.
   * It corrected itself on the next store change, which is why it looked like
   * a rendering race rather than an ordering mistake.
   */
  it('populates its lists on open, not on the next store change', () => {
    const store = new Store()
    store.createProject('Uni')
    store.createTag('admin')

    const manage = new Manage(store, silent)
    document.body.append(manage.root)
    manage.open()

    expect(manage.root.querySelectorAll('.manage-row')).toHaveLength(2)
    expect([...manage.root.querySelectorAll('.manage-name')].map((n) => (n as HTMLInputElement).value))
      .toEqual(['Uni', 'admin'])
  })

  it('shows its empty states only when the catalogues really are empty', () => {
    const store = new Store()
    const manage = new Manage(store, silent)
    document.body.append(manage.root)
    manage.open()

    const hints = [...manage.root.querySelectorAll('.field-hint')] as HTMLElement[]
    expect(hints.every((h) => !h.hidden)).toBe(true)
    expect(manage.root.querySelectorAll('.manage-row')).toHaveLength(0)
  })
})

describe('TaskDetail', () => {
  const twoTasks = (): { store: Store; a: string; b: string; detail: TaskDetail } => {
    const store = new Store()
    const a = store.addTask({ title: 'First' })
    const b = store.addTask({ title: 'Second' })
    const detail = new TaskDetail(store, silent)
    document.body.append(detail.root)
    return { store, a, b, detail }
  }

  /*
   * The bug: the dialog is one long-lived node reused for every task, so its
   * scrolling body kept whatever offset the previous task was left at. Opening
   * a short task after scrolling through a long one showed it already scrolled
   * past its own title and notes.
   */
  it('opens at the top of its content, not where the last task was left', () => {
    const { a, b, detail } = twoTasks()
    const body = detail.root.querySelector<HTMLElement>('.detail-body')!

    detail.open(a)
    body.scrollTop = 120
    detail.close()

    detail.open(b)
    expect(body.scrollTop).toBe(0)
  })

  it('flushes a field typed into but not left, so dismissing never loses a word', () => {
    const { store, a, detail } = twoTasks()
    detail.open(a)

    // What Escape does: the dialog closes while the caret is still in the
    // field, so `change` has not fired and only `input` has.
    const title = detail.root.querySelector<HTMLInputElement>('.detail-title')!
    title.value = 'First, renamed'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    detail.root.close()

    expect(store.getState().tasks.find((t) => t.id === a)?.title).toBe('First, renamed')
  })

  it('does not commit the same edit twice when the field is left normally', () => {
    const { store, a, detail } = twoTasks()
    detail.open(a)

    const title = detail.root.querySelector<HTMLInputElement>('.detail-title')!
    title.value = 'Renamed once'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    title.dispatchEvent(new Event('change', { bubbles: true }))
    detail.close()

    expect(store.getState().tasks.find((t) => t.id === a)?.title).toBe('Renamed once')
    // One undoable step, not two: `change` clears the pending flush.
    store.undo()
    expect(store.getState().tasks.find((t) => t.id === a)?.title).toBe('First')
  })
})

describe('restoreFocus', () => {
  const button = (id: string): HTMLButtonElement => {
    const node = document.createElement('button')
    node.id = id
    document.body.append(node)
    return node
  }

  it('uses the preferred node when it is still in the document', () => {
    const preferred = button('preferred')
    const fallback = button('fallback')
    expect(restoreFocus(preferred, fallback)).toBe(true)
    expect(document.activeElement).toBe(preferred)
  })

  /*
   * The case this exists for: the edit made in a dialog destroyed the control
   * that opened it — a completed task's row, a deleted project's line. Calling
   * focus() on a detached node does nothing and focus lands on <body>, which
   * ends keyboard navigation until the user tabs in from the top of the page.
   */
  it('falls through to the next candidate when the preferred node has been removed', () => {
    const preferred = button('preferred')
    const fallback = button('fallback')
    preferred.remove()

    expect(restoreFocus(preferred, fallback)).toBe(true)
    expect(document.activeElement).toBe(fallback)
  })

  it('accepts lazy fallbacks, so a caller can name a node that does not exist yet', () => {
    const preferred = button('preferred')
    preferred.remove()
    const late = button('late')

    expect(restoreFocus(preferred, () => document.querySelector<HTMLElement>('#late'))).toBe(true)
    expect(document.activeElement).toBe(late)
  })

  it('reports failure rather than pretending, when nothing can take focus', () => {
    const gone = button('gone')
    gone.remove()
    expect(restoreFocus(gone, null, () => null)).toBe(false)
  })
})

/*
 * Phase 8. The effects preference finally has a control, and the interesting
 * part of it is not the radios — it is that all three settings here have a
 * system-following default plus explicit choices, and an explicit choice has
 * to outrank the OS in both directions. A control that writes the setting but
 * shows the request rather than the outcome is the failure worth testing for:
 * the user asks for full motion on a machine with no WebGL2, gets a gradient,
 * and has nothing on screen telling them why.
 */
describe('Settings', () => {
  const status = (dialog: Settings): string =>
    dialog.root.querySelector('.settings-status')?.textContent ?? ''

  function open(effectsStatus = () => 'The surface is flowing.'): {
    store: Store
    dialog: Settings
    said: string[]
  } {
    const store = new Store()
    const said: string[] = []
    const dialog = new Settings(store, { announce: (m) => said.push(m), effectsStatus })
    document.body.append(dialog.root)
    dialog.open()
    return { store, dialog, said }
  }

  it('draws four options for effects, not three', () => {
    // `auto` is the whole reason the preference is independent of the OS rather
    // than merely unaware of it. Dropping it is the tempting simplification.
    const { dialog } = open()
    const values = [...dialog.root.querySelectorAll<HTMLInputElement>('input[name="settings-effects"]')]
      .map((input) => input.value)
    expect(values).toEqual(['auto', 'full', 'reduced', 'off'])
  })

  it('opens on the current answer rather than the first option', () => {
    const { dialog } = open()
    const checked = dialog.root.querySelectorAll<HTMLInputElement>('input:checked')
    expect([...checked].map((input) => input.value)).toEqual(['auto', 'system', '1'])
  })

  it('saves the moment a choice is made, with no Apply to press', () => {
    const { store, dialog, said } = open()
    const reduced = dialog.root.querySelector<HTMLInputElement>('#settings-effects-reduced')!
    reduced.checked = true
    reduced.dispatchEvent(new Event('change'))

    expect(store.getState().settings.effects).toBe('reduced')
    expect(said).toContain('Background effects: Reduced')
  })

  it('carries the choice into storage, so it survives a reload', () => {
    const { store, dialog } = open()
    const light = dialog.root.querySelector<HTMLInputElement>('#settings-theme-light')!
    light.checked = true
    light.dispatchEvent(new Event('change'))
    store.flush()

    expect(new Store().getState().settings.theme).toBe('light')
  })

  it('reports what the surface actually did, not what was asked for', () => {
    // The preference is a request; WebGL2 and the OS both get a say after it.
    const { dialog } = open(() => 'WebGL2 is not available here, so the background is the plain gradient.')
    expect(status(dialog)).toContain('WebGL2 is not available')
  })

  it('names each group of radios with a legend', () => {
    const { dialog } = open()
    const legends = [...dialog.root.querySelectorAll('legend')].map((l) => l.textContent)
    expect(legends).toEqual(['Background effects', 'Theme', 'Week starts on'])
  })

  it('re-reads the store when something else changes it', () => {
    const { store, dialog } = open()
    store.setSettings({ effects: 'off' })
    dialog.sync(store.getState())
    expect(dialog.root.querySelector<HTMLInputElement>('#settings-effects-off')!.checked).toBe(true)
  })
})
