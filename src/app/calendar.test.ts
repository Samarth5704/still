/**
 * @vitest-environment happy-dom
 *
 * The calendar's behaviour, driven through its real DOM.
 *
 * `lib/calendar.test.ts` covers what belongs on which day. What can only be
 * tested here is the part that is about the *control*: the roving tabindex,
 * the difference between moving focus and choosing a day, and the fact that a
 * grid you cannot reach with the keyboard typechecks perfectly.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Calendar } from './calendar.ts'
import { defaultState } from '../lib/storage.ts'
import type { ISODate, Recurrence, State, Task } from '../lib/types.ts'

const TODAY: ISODate = '2026-09-06' // a Sunday

const task = (over: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
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
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
})

const stateWith = (tasks: Task[] = [], recurrences: Recurrence[] = []): State => ({
  ...defaultState(),
  tasks,
  recurrences,
})

type Recorded = {
  selected: ISODate[]
  opened: string[]
  toggled: string[]
  said: string[]
}

function mount(state: State = stateWith(), selected: ISODate | null = null) {
  const log: Recorded = { selected: [], opened: [], toggled: [], said: [] }
  const calendar = new Calendar({
    onSelectDay: (day) => {
      log.selected.push(day)
      calendar.render(state, TODAY, 1, day)
    },
    onOpenTask: (id) => log.opened.push(id),
    onToggle: (id) => log.toggled.push(id),
    announce: (message) => log.said.push(message),
  })
  document.body.replaceChildren(calendar.root)
  calendar.render(state, TODAY, 1, selected)
  return { calendar, log, state }
}

const cells = () => [...document.querySelectorAll<HTMLElement>('.cal-cell')]
const cell = (date: ISODate) => cells().find((c) => c.dataset.date === date)!
const focusable = () => document.querySelector<HTMLElement>('.cal-grid [tabindex="0"]')

function press(key: string, opts: KeyboardEventInit = {}): void {
  document
    .querySelector('.cal-grid')!
    .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('the month grid', () => {
  it('draws six whole weeks around the month it opens on', () => {
    mount()
    expect(cells()).toHaveLength(42)
    expect(cells()[0]!.dataset.date).toBe('2026-08-31')
    expect(document.querySelector('.cal-title')!.textContent).toBe('September 2026')
  })

  it('opens on today when the URL names no day', () => {
    mount()
    expect(cell(TODAY).classList.contains('is-today')).toBe(true)
    expect(cell(TODAY).getAttribute('aria-selected')).toBe('true')
  })

  it('opens on the day the URL names', () => {
    mount(stateWith(), '2026-10-20')
    expect(document.querySelector('.cal-title')!.textContent).toBe('October 2026')
    expect(cell('2026-10-20').getAttribute('aria-selected')).toBe('true')
  })

  /*
   * Today has to be findable without colour. The mark is a filled disc behind
   * the numeral — a luminance reversal — and `aria-current` says the same thing
   * to anyone not looking at the grid at all.
   */
  it('marks today in a way that does not depend on colour', () => {
    mount()
    expect(cell(TODAY).getAttribute('aria-current')).toBe('date')
    expect(cell(TODAY).querySelector('.cal-num')).not.toBeNull()
    expect(cell('2026-09-07').hasAttribute('aria-current')).toBe(false)
  })

  it('names each day with its load, for a reader that never sees the dots', () => {
    mount(stateWith([task({ id: 'a', title: 'Essay', due: '2026-09-09' })]))
    expect(cell('2026-09-09').getAttribute('aria-label')).toBe(
      'Wednesday 9 September. 1 task',
    )
    expect(cell('2026-09-10').getAttribute('aria-label')).toBe(
      'Thursday 10 September. Nothing scheduled',
    )
  })

  it('shows a repeating task on every date the rule produces', () => {
    const state = stateWith(
      [task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'r1' })],
      [
        {
          id: 'r1', freq: 'weekly', interval: 1, byWeekday: [1], weekStart: 1,
          starts: '2026-09-07', ends: { type: 'never' }, exceptions: [],
        },
      ],
    )
    mount(state)
    for (const date of ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']) {
      expect(cell(date).textContent, date).toContain('Standup')
    }
  })
})

describe('keyboard navigation', () => {
  it('keeps exactly one cell in the tab order', () => {
    mount()
    expect(document.querySelectorAll('.cal-cell[tabindex="0"]')).toHaveLength(1)
    expect(focusable()!.dataset.date).toBe(TODAY)
  })

  it('moves by a day with left and right, and by a week with up and down', () => {
    mount()
    press('ArrowRight')
    expect(focusable()!.dataset.date).toBe('2026-09-07')
    press('ArrowDown')
    expect(focusable()!.dataset.date).toBe('2026-09-14')
    press('ArrowUp')
    expect(focusable()!.dataset.date).toBe('2026-09-07')
    press('ArrowLeft')
    expect(focusable()!.dataset.date).toBe(TODAY)
  })

  it('moves by a month with the page keys, turning the grid over with it', () => {
    mount()
    press('PageDown')
    expect(document.querySelector('.cal-title')!.textContent).toBe('October 2026')
    expect(focusable()!.dataset.date).toBe('2026-10-06')
    press('PageUp', { shiftKey: true })
    expect(document.querySelector('.cal-title')!.textContent).toBe('October 2025')
  })

  it('goes to the edges of the week with Home and End', () => {
    mount(stateWith(), '2026-09-16')
    press('Home')
    expect(focusable()!.dataset.date).toBe('2026-09-14')
    press('End')
    expect(focusable()!.dataset.date).toBe('2026-09-20')
  })

  /*
   * The whole reason focus and selection are separate. Walking across a week
   * with the arrow keys must not push seven history entries or re-announce the
   * day panel seven times; it announces where focus landed, and Enter is what
   * commits.
   */
  it('moves focus without selecting, and selects on Enter', () => {
    const { log } = mount()
    press('ArrowRight')
    press('ArrowRight')

    expect(log.selected).toEqual([])
    expect(log.said).toEqual([
      'Tomorrow · Monday 7 September. Nothing scheduled',
      'Tuesday 8 September. Nothing scheduled',
    ])

    press('Enter')
    expect(log.selected).toEqual(['2026-09-08'])
  })

  /*
   * REGRESSION. `render` decides whether the incoming selection should take
   * focus. Comparing it against the *focused* day — `selected !== this.focus` —
   * means every arrow key is undone by the re-render it triggers: focus moves
   * to the 17th, the component re-renders with the selection still on the 16th,
   * and 16 !== 17 puts focus straight back. The grid then looks like it has no
   * keyboard navigation at all, and it typechecks perfectly.
   *
   * It only shows up once a day is actually selected, which is why every other
   * keyboard test here mounts with one.
   */
  it('does not snap focus back to the selected day on the render it triggers', () => {
    mount(stateWith(), '2026-09-16')
    expect(focusable()!.dataset.date).toBe('2026-09-16')

    press('ArrowRight')
    expect(focusable()!.dataset.date).toBe('2026-09-17')
    press('ArrowRight')
    expect(focusable()!.dataset.date).toBe('2026-09-18')

    // And the selection has not moved with it: the two are independent.
    expect(cell('2026-09-16').getAttribute('aria-selected')).toBe('true')
    expect(cell('2026-09-18').getAttribute('aria-selected')).toBe('false')
  })

  it('selects on Space too, and swallows the key so the page does not scroll', () => {
    const { log } = mount()
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    document.querySelector('.cal-grid')!.dispatchEvent(event)
    expect(log.selected).toEqual([TODAY])
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets every other key through untouched', () => {
    mount()
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    document.querySelector('.cal-grid')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  /*
   * Clicking "Calendar" in the sidebar while looking at a specific day drops
   * the day from the URL. Focus has to come back with the selection, or the
   * panel reads today while the keyboard is still parked three weeks away.
   */
  it('comes back to today when the selection is dropped from outside', () => {
    const { calendar, state } = mount(stateWith(), '2026-09-23')
    expect(focusable()!.dataset.date).toBe('2026-09-23')
    calendar.render(state, TODAY, 1, null)
    expect(focusable()!.dataset.date).toBe(TODAY)
  })

  it('follows focus off the edge of the month rather than stopping at it', () => {
    mount(stateWith(), '2026-09-30')
    press('ArrowRight')
    expect(document.querySelector('.cal-title')!.textContent).toBe('October 2026')
    expect(focusable()!.dataset.date).toBe('2026-10-01')
  })
})

describe('choosing a day', () => {
  it('reports the day a click landed on rather than opening anything', () => {
    const { log } = mount()
    cell('2026-09-11').click()
    expect(log.selected).toEqual(['2026-09-11'])
    expect(document.querySelectorAll('dialog')).toHaveLength(0)
  })

  it('filters the list below to that day', () => {
    const state = stateWith([
      task({ id: 'a', title: 'Essay', due: '2026-09-09' }),
      task({ id: 'b', title: 'Passport', due: '2026-09-11' }),
    ])
    mount(state)
    cell('2026-09-09').click()

    expect(document.querySelector('.cal-day-title')!.textContent).toBe('Wednesday 9 September')
    const titles = [...document.querySelectorAll('.cal-day-list .task-title')].map((n) => n.textContent)
    expect(titles).toEqual(['Essay'])
  })

  it('says so plainly when the day is empty', () => {
    mount()
    cell('2026-09-11').click()
    expect(document.querySelector<HTMLElement>('.cal-day-empty')!.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('.cal-day-list')!.hidden).toBe(true)
  })

  it('opens a task from the day list', () => {
    const { log } = mount(stateWith([task({ id: 'a', title: 'Essay', due: TODAY })]))
    document.querySelector<HTMLButtonElement>('.cal-day-list .task-title')!.click()
    expect(log.opened).toEqual(['a'])
  })
})

describe('what can and cannot be ticked', () => {
  const repeating = () =>
    stateWith(
      [task({ id: 't1', title: 'Standup', due: '2026-09-07', recurrenceId: 'r1' })],
      [
        {
          id: 'r1', freq: 'weekly', interval: 1, byWeekday: [1], weekStart: 1,
          starts: '2026-09-07', ends: { type: 'never' }, exceptions: [],
        },
      ],
    )

  it('offers a tick on the occurrence the task is sitting on', () => {
    const { log } = mount(repeating(), '2026-09-07')
    const check = document.querySelector<HTMLButtonElement>('.cal-day-list .check')!
    expect(check.hidden).toBe(false)
    check.click()
    expect(log.toggled).toEqual(['t1'])
  })

  /*
   * A checkbox on next Monday's occurrence would tick *this* Monday's, because
   * the task's `due` is what `setDone` acts on. Showing a mark instead is the
   * only honest option.
   */
  it('shows a mark, not a checkbox, on an occurrence further down the series', () => {
    mount(repeating(), '2026-09-14')
    const row = document.querySelector('.cal-day-list .cal-entry')!
    expect(row.querySelector<HTMLElement>('.check')!.hidden).toBe(true)
    expect(row.querySelector<HTMLElement>('.cal-entry-mark')!.hidden).toBe(false)
    expect(row.textContent).toContain('scheduled')
  })

  it('names a finished occurrence in words as well as in strike-through', () => {
    const state = repeating()
    state.recurrences[0]!.exceptions = [
      { date: '2026-09-07', kind: 'completed', completedAt: '2026-09-07T09:00:00.000Z' },
    ]
    state.tasks[0]!.due = '2026-09-14'
    mount(state, '2026-09-07')

    const row = document.querySelector('.cal-day-list .cal-entry')!
    expect(row.getAttribute('data-status')).toBe('completed')
    expect(row.textContent).toContain('completed')
  })
})

describe('the agenda', () => {
  const showAgenda = (): void => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.cal-mode')].find(
      (b) => b.textContent === 'Agenda',
    )!
    button.click()
  }

  it('swaps the grid out for a day-by-day list of the month', () => {
    mount()
    showAgenda()
    expect(document.querySelector<HTMLElement>('.cal-grid')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('.cal-agenda')!.hidden).toBe(false)
    expect(document.querySelectorAll('.agenda-row')).toHaveLength(30)
  })

  /* An empty week is information, so the empty days keep their rows. */
  it('keeps the empty days visible', () => {
    mount(stateWith([task({ id: 'a', title: 'Essay', due: '2026-09-09' })]))
    showAgenda()
    const rows = [...document.querySelectorAll('.agenda-row')]
    expect(rows.filter((r) => r.classList.contains('is-empty'))).toHaveLength(29)
    expect(rows[8]!.textContent).toContain('Essay')
  })

  it('is the grid rotated: up and down step a day, left and right a week', () => {
    mount()
    showAgenda()
    const agenda = document.querySelector('.cal-agenda')!
    const focused = () => agenda.querySelector<HTMLElement>('[data-focus-day]')!

    agenda.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(focused().closest('.agenda-row')!.textContent).toContain('Monday 7 September')

    agenda.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(focused().closest('.agenda-row')!.textContent).toContain('Monday 14 September')
  })

  /*
   * Both layouts mark their focused day, and the grid comes first in the
   * document. Querying the whole component for it returns the hidden grid's
   * cell, `.focus()` on a hidden node quietly does nothing, and switching to
   * the agenda leaves focus on the button that switched it — a keyboard user
   * arrives in a list they cannot move around.
   */
  it('hands focus to the layout it switched to, not the one it hid', () => {
    mount(stateWith(), '2026-09-23')
    showAgenda()
    expect(document.activeElement?.className).toContain('agenda-day')
    expect(document.activeElement?.textContent).toContain('23 September')
  })

  it('selects a day from its heading', () => {
    const { log } = mount()
    showAgenda()
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.agenda-day')]
    rows[10]!.click()
    expect(log.selected).toEqual(['2026-09-11'])
  })
})

describe('the month controls', () => {
  it('steps back and forward a month', () => {
    mount()
    document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click()
    expect(document.querySelector('.cal-title')!.textContent).toBe('October 2026')
    document.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click()
    document.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click()
    expect(document.querySelector('.cal-title')!.textContent).toBe('August 2026')
  })

  it('clamps the day when the month it steps into is shorter', () => {
    mount(stateWith(), '2026-10-31')
    document.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click()
    expect(focusable()!.dataset.date).toBe('2026-09-30')
  })

  it('comes back to today, and selects it', () => {
    const { log } = mount(stateWith(), '2027-03-04')
    document.querySelector<HTMLButtonElement>('.cal-today')!.click()
    expect(document.querySelector('.cal-title')!.textContent).toBe('September 2026')
    expect(log.selected).toEqual([TODAY])
  })
})
