/**
 * @vitest-environment happy-dom
 *
 * What a render of the calendar *costs*, counted rather than assumed.
 *
 * `occurrencesBetween` walks a rule. The number of times it runs per render is
 * therefore the whole performance story of this view, and it is a number that
 * can regress silently: shaping the grid, the agenda and the day panel from
 * three separate fetches looks identical on screen and triples the walk, and
 * asking for a day's entries from inside the cell loop would multiply it by
 * forty-two without changing a pixel.
 *
 * This file asserts the shape of that cost — one walk per rule per render, flat
 * in the number of cells — rather than a wall-clock time, which would be a
 * flaky test on shared CI hardware. The measured timings live in the commit
 * message and in Phase 8's budget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const walks = { count: 0 }

vi.mock('../lib/recurrence.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/recurrence.ts')>()
  return {
    ...actual,
    occurrencesBetween: (...args: Parameters<typeof actual.occurrencesBetween>) => {
      walks.count += 1
      return actual.occurrencesBetween(...args)
    },
  }
})

const { Calendar } = await import('./calendar.ts')
const { defaultState } = await import('../lib/storage.ts')
type State = import('../lib/types.ts').State
type Task = import('../lib/types.ts').Task
type Recurrence = import('../lib/types.ts').Recurrence
type ISODate = import('../lib/types.ts').ISODate

const TODAY: ISODate = '2026-09-06'

/** 300 tasks across 40 rules: 40 repeating, 260 plain, spread over the year. */
function heavyState(): State {
  const tasks: Task[] = []
  const recurrences: Recurrence[] = []
  const freqs = ['daily', 'weekly', 'monthly', 'yearly'] as const

  for (let r = 0; r < 40; r += 1) {
    recurrences.push({
      id: `r${r}`,
      freq: freqs[r % 4]!,
      interval: (r % 3) + 1,
      byWeekday: r % 4 === 1 ? [r % 7] : undefined,
      weekStart: 1,
      starts: `2026-0${(r % 9) + 1}-0${(r % 8) + 1}`,
      ends: r % 5 === 0 ? { type: 'after', count: 60 } : { type: 'never' },
      exceptions: [],
    })
  }

  for (let t = 0; t < 300; t += 1) {
    const repeating = t < 40
    tasks.push({
      id: `t${t}`,
      title: `Task ${t}`,
      notes: '',
      done: false,
      completedAt: null,
      due: `2026-${String((t % 12) + 1).padStart(2, '0')}-${String((t % 28) + 1).padStart(2, '0')}`,
      dueTime: null,
      priority: 'none',
      projectId: null,
      tagIds: [],
      parentId: null,
      order: t,
      recurrenceId: repeating ? `r${t}` : null,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  }

  return { ...defaultState(), tasks, recurrences }
}

function mount(state: State) {
  const calendar = new Calendar({
    onSelectDay: (day) => calendar.render(state, TODAY, 1, day),
    onOpenTask: () => {},
    onToggle: () => {},
    announce: () => {},
  })
  document.body.replaceChildren(calendar.root)
  return calendar
}

const RULES = 40

beforeEach(() => {
  document.body.replaceChildren()
  walks.count = 0
})

describe('a render walks each rule once', () => {
  it('fetches once for the grid, the agenda and the day panel together', () => {
    const state = heavyState()
    const calendar = mount(state)

    walks.count = 0
    calendar.render(state, TODAY, 1, null)

    // One walk per rule. Not three — one for the grid, one for the agenda's
    // month, one for the single-day panel — which is what separate fetches cost.
    expect(walks.count).toBe(RULES)
  })

  /*
   * The regression that would hurt most: reading a day's entries from inside
   * the cell loop. Forty-two cells times forty rules is 1,680 walks for a
   * screen that currently costs 40, and it would look exactly the same.
   */
  it('does not grow with the number of cells on the grid', () => {
    const state = heavyState()
    const calendar = mount(state)

    walks.count = 0
    calendar.render(state, TODAY, 1, null)
    const oneMonth = walks.count

    expect(oneMonth).toBeLessThan(42)
    expect(oneMonth).toBe(RULES)
  })

  /*
   * Paging does not move the selection, so the day panel goes on showing a day
   * the new month's window does not reach — and it fetches that one day rather
   * than showing an empty panel. That is a second pass over the rules, but a
   * one-day one: the walker fast-forwards to the window and stops at the first
   * date past it, where the grid's pass spans six weeks.
   *
   * The number that matters is that it is flat: 2 x 40, not 42 x 40.
   */
  it('pages a month for a constant cost, not one per cell', () => {
    const state = heavyState()
    const calendar = mount(state)
    calendar.render(state, TODAY, 1, null)

    walks.count = 0
    document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click()
    const onePage = walks.count

    expect(onePage).toBe(RULES * 2)
    expect(onePage).toBeLessThan(RULES * 42)

    walks.count = 0
    for (let i = 0; i < 6; i += 1) {
      document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click()
    }
    // Linear in pages, flat in cells.
    expect(walks.count).toBe(onePage * 6)
  })

  it('is back to one pass once a day in the month on screen is chosen', () => {
    const state = heavyState()
    const calendar = mount(state)
    calendar.render(state, TODAY, 1, null)
    document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click()

    walks.count = 0
    calendar.render(state, TODAY, 1, '2026-10-14')
    expect(walks.count).toBe(RULES)
  })

  it('costs one render to move focus a day, announcement included', () => {
    const state = heavyState()
    const calendar = mount(state)
    calendar.render(state, TODAY, 1, null)

    walks.count = 0
    document
      .querySelector('.cal-grid')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))

    // The spoken summary for the day focus landed on reads from the window the
    // re-render just built, rather than fetching that one day again.
    expect(walks.count).toBe(RULES)
  })

  it('switches layout without a second walk per rule', () => {
    const state = heavyState()
    const calendar = mount(state)
    calendar.render(state, TODAY, 1, null)

    walks.count = 0
    ;[...document.querySelectorAll<HTMLButtonElement>('.cal-mode')]
      .find((b) => b.textContent === 'Agenda')!
      .click()
    expect(walks.count).toBe(RULES)
  })
})
