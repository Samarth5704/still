/**
 * @vitest-environment happy-dom
 *
 * Phase 5, from the outside.
 *
 * `lib/series.test.ts` proves the arithmetic. This file proves the behaviour a
 * user would notice: that ticking a repeating task advances it instead of
 * finishing it, that a skip is visible in the count, that "this and all future"
 * really does leave two rules behind, and that the editor commits nothing until
 * Save.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { RecurrenceEditor } from './recurrence.ts'
import { Store } from './store.ts'
import { addDays, weekday } from '../lib/dates.ts'
import type { RuleFields } from '../lib/series.ts'
import type { Recurrence, Task } from '../lib/types.ts'

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})

type Fixture = { store: Store; id: string; today: string }

/** A task repeating daily from today, which is where every case below starts. */
function daily(ends?: RuleFields['ends']): Fixture {
  const store = new Store()
  const today = store.getToday()
  const id = store.addTask({
    title: 'Water the plants',
    recurrence: { freq: 'daily', interval: 1, starts: today, weekStart: 1 },
  })
  if (ends) {
    store.setRecurrence(id, { freq: 'daily', interval: 1, starts: today, weekStart: 1, ends })
  }
  return { store, id, today }
}

const taskIn = (store: Store, id: string): Task =>
  store.getState().tasks.find((t) => t.id === id)!

const ruleIn = (store: Store, id: string): Recurrence =>
  store.ruleFor(taskIn(store, id))!

describe('completing an occurrence', () => {
  it('advances to the next date and leaves the task open', () => {
    const { store, id, today } = daily()
    store.setDone(id, true)

    const task = taskIn(store, id)
    expect(task.done).toBe(false)
    expect(task.due).toBe(addDays(today, 1))
  })

  it('records an exception and never touches the rule', () => {
    const { store, id, today } = daily()
    const before = ruleIn(store, id)
    store.setDone(id, true)
    const after = ruleIn(store, id)

    expect(after.exceptions).toHaveLength(1)
    expect(after.exceptions[0]).toMatchObject({ date: today, kind: 'completed' })
    expect(after.freq).toBe(before.freq)
    expect(after.starts).toBe(before.starts)
    expect(after.ends).toEqual(before.ends)
  })

  /*
   * The whole reason `setDone` routes repeating tasks away from itself: every
   * caller — the list checkbox, the close-the-parent prompt, a keyboard
   * shortcut — would otherwise have to remember to, and one of them would not.
   */
  it('finishes the task itself only when the series runs out', () => {
    const { store, id } = daily({ type: 'after', count: 2 })
    store.setDone(id, true)
    expect(taskIn(store, id).done).toBe(false)

    store.setDone(id, true)
    expect(taskIn(store, id).done).toBe(true)
  })

  it('brings the checklist back for the next occurrence', () => {
    const { store, id } = daily()
    store.addSubtask(id, 'Kitchen')
    store.addSubtask(id, 'Bedroom')
    const child = store.getState().tasks.find((t) => t.parentId === id)!
    store.setDone(child.id, true)

    store.setDone(id, true)

    const children = store.getState().tasks.filter((t) => t.parentId === id)
    expect(children.every((c) => !c.done)).toBe(true)
  })

  it('is one undoable step, back to the occurrence just ticked', () => {
    const { store, id, today } = daily()
    store.setDone(id, true)
    store.undo()

    expect(taskIn(store, id).due).toBe(today)
    expect(ruleIn(store, id).exceptions).toEqual([])
  })
})

describe('skipping an occurrence', () => {
  it('advances without recording it as done', () => {
    const { store, id, today } = daily()
    const result = store.skipOccurrence(id)

    expect(result?.advancedTo).toBe(addDays(today, 1))
    expect(ruleIn(store, id).exceptions).toEqual([{ date: today, kind: 'skipped' }])
    expect(taskIn(store, id).done).toBe(false)
  })

  /*
   * The reason the task says "3 of 10 scheduled" and never "7 left": a skip
   * spends one of the ten, so a remainder would be a number that quietly
   * disagreed with the rule.
   */
  it('spends one of a counted rule, which the position shows', () => {
    const { store, id } = daily({ type: 'after', count: 3 })
    store.skipOccurrence(id)
    store.skipOccurrence(id)
    store.skipOccurrence(id)

    expect(taskIn(store, id).done).toBe(true)
  })
})

describe('changing the rule', () => {
  it('rewrites it in place for the whole series, keeping its history', () => {
    const { store, id, today } = daily()
    store.setDone(id, true)
    const ruleId = taskIn(store, id).recurrenceId

    store.setRecurrence(
      id,
      { freq: 'weekly', interval: 1, starts: today, weekStart: 1, byWeekday: [weekday(today)], ends: { type: 'never' } },
      'series',
    )

    const rule = ruleIn(store, id)
    expect(rule.id).toBe(ruleId)
    expect(rule.freq).toBe('weekly')
    expect(rule.exceptions).toHaveLength(1)
    expect(store.getState().recurrences).toHaveLength(1)
  })

  it('splits into two rules for "this and all future"', () => {
    const { store, id, today } = daily()
    store.setDone(id, true)
    const originalId = taskIn(store, id).recurrenceId!
    const splitAt = taskIn(store, id).due!

    store.setRecurrence(
      id,
      { freq: 'daily', interval: 2, starts: splitAt, weekStart: 1, ends: { type: 'never' } },
      'future',
    )

    const rules = store.getState().recurrences
    expect(rules).toHaveLength(2)

    const previous = rules.find((r) => r.id === originalId)!
    expect(previous.ends).toEqual({ type: 'until', date: today })
    expect(previous.exceptions).toHaveLength(1)

    const current = ruleIn(store, id)
    expect(current.id).not.toBe(originalId)
    expect(current.interval).toBe(2)
    expect(current.starts).toBe(splitAt)
    expect(current.exceptions).toEqual([])
  })

  it('drops the first half when nothing happened in it worth keeping', () => {
    const { store, id, today } = daily()
    store.setRecurrence(
      id,
      { freq: 'daily', interval: 3, starts: today, weekStart: 1, ends: { type: 'never' } },
      'future',
    )
    expect(store.getState().recurrences).toHaveLength(1)
  })

  it('carries the unused half of a count rather than restating it', () => {
    const { store, id } = daily({ type: 'after', count: 10 })
    store.setDone(id, true)
    store.setDone(id, true)
    const splitAt = taskIn(store, id).due!

    store.setRecurrence(
      id,
      { freq: 'daily', interval: 1, starts: splitAt, weekStart: 1, ends: { type: 'after', count: 10 } },
      'future',
    )

    // Two of the ten are spent, so the new half runs eight — not ten again.
    expect(ruleIn(store, id).ends).toEqual({ type: 'after', count: 8 })
  })

  it('takes an end the user actually changed at face value', () => {
    const { store, id } = daily({ type: 'after', count: 10 })
    store.setDone(id, true)
    const splitAt = taskIn(store, id).due!

    store.setRecurrence(
      id,
      { freq: 'daily', interval: 1, starts: splitAt, weekStart: 1, ends: { type: 'after', count: 4 } },
      'future',
    )
    expect(ruleIn(store, id).ends).toEqual({ type: 'after', count: 4 })
  })
})

describe('editing a repeating task at a scope', () => {
  it('changes the task itself for the whole series', () => {
    const { store, id } = daily()
    const landed = store.applyScopedPatch(id, { title: 'Water everything' }, 'series', 'Renamed task')

    expect(landed).toBe(id)
    expect(taskIn(store, id).title).toBe('Water everything')
    expect(store.getState().tasks).toHaveLength(1)
  })

  it('lifts one occurrence out as a task of its own', () => {
    const { store, id, today } = daily()
    const landed = store.applyScopedPatch(id, { title: 'Water them twice' }, 'occurrence', 'Renamed task')

    expect(landed).not.toBe(id)
    const detached = taskIn(store, landed)
    expect(detached.recurrenceId).toBeNull()
    expect(detached.due).toBe(today)
    expect(detached.title).toBe('Water them twice')

    // The series carries on, one occurrence lighter, with today spoken for.
    expect(ruleIn(store, id).exceptions).toEqual([{ date: today, kind: 'skipped' }])
    expect(taskIn(store, id).due).toBe(addDays(today, 1))
    expect(taskIn(store, id).title).toBe('Water the plants')
  })

  /*
   * A date change to one occurrence is exactly what a 'moved' exception is
   * for. Detaching here would leave two tasks where the user asked for one to
   * happen a day later.
   */
  it('moves one occurrence rather than detaching it when only the date changed', () => {
    const { store, id, today } = daily()
    const to = addDays(today, 3)
    const landed = store.applyScopedPatch(id, { due: to }, 'occurrence', 'Changed the date')

    expect(landed).toBe(id)
    expect(store.getState().tasks).toHaveLength(1)
    expect(taskIn(store, id).due).toBe(to)
    expect(ruleIn(store, id).exceptions).toEqual([{ date: today, kind: 'moved', movedTo: to }])
  })

  /*
   * The boundary between the two gestures above, which are one field apart.
   * A date change alone is a move; a date change carrying anything else is a
   * different occurrence of the task, not the same one on another day, so it
   * has to detach or the other edit would silently land on the whole series.
   */
  it('detaches, not moves, when the date change is not the only change', () => {
    const { store, id, today } = daily()
    const to = addDays(today, 3)
    const landed = store.applyScopedPatch(
      id,
      { due: to, priority: 'urgent' },
      'occurrence',
      'Edited task',
    )

    expect(landed).not.toBe(id)
    expect(store.getState().tasks).toHaveLength(2)
    expect(taskIn(store, landed)).toMatchObject({ due: to, priority: 'urgent', recurrenceId: null })
    // The series is unmoved: today was spent, not relocated.
    expect(ruleIn(store, id).exceptions).toEqual([{ date: today, kind: 'skipped' }])
    expect(taskIn(store, id).priority).toBe('none')
  })

  it('splits the rule for "this and all future" and applies the edit forward', () => {
    const { store, id } = daily()
    store.setDone(id, true)
    const originalId = taskIn(store, id).recurrenceId

    store.applyScopedPatch(id, { priority: 'high' }, 'future', 'Priority: High')

    expect(taskIn(store, id).priority).toBe('high')
    expect(taskIn(store, id).recurrenceId).not.toBe(originalId)
    expect(store.getState().recurrences).toHaveLength(2)
  })
})

describe('the editor', () => {
  const open = (rule: Recurrence | null = null) => {
    const editor = new RecurrenceEditor()
    document.body.append(editor.root)
    const result = editor.open({ rule, today: '2026-01-05', due: null, weekStart: 1 })
    return { editor, result }
  }

  const q = <T extends Element>(editor: RecurrenceEditor, selector: string): T =>
    editor.root.querySelector<T>(selector)!

  it('reads the rule back in words and in dates', () => {
    const { editor } = open()
    expect(q(editor, '.repeat-summary').textContent).toBe('Every week on Monday')
    expect([...editor.root.querySelectorAll('.repeat-preview-date')].map((n) => n.textContent))
      .toEqual(['5 January', '12 January', '19 January', '26 January', '2 February'])
  })

  it('updates both the moment a control changes', () => {
    const { editor } = open()
    const thursday = q<HTMLInputElement>(editor, '#repeat-weekday-4')
    thursday.checked = true
    thursday.dispatchEvent(new Event('change'))

    expect(q(editor, '.repeat-summary').textContent).toBe('Every week on Monday and Thursday')
  })

  /*
   * Half-built rules are the reason this dialog holds a draft instead of
   * saving as it goes: a weekly rule with no weekdays is not a rule, and it
   * must not be possible to leave one behind on a task.
   */
  it('refuses to save a rule that is not one yet, and says why', () => {
    const { editor } = open()
    const monday = q<HTMLInputElement>(editor, '#repeat-weekday-1')
    monday.checked = false
    monday.dispatchEvent(new Event('change'))

    const error = q<HTMLElement>(editor, '.manage-error')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('at least one day')
    expect(q<HTMLButtonElement>(editor, '.repeat-actions .text-button.is-primary').disabled).toBe(true)
  })

  it('throws the draft away on Cancel', async () => {
    const { editor, result } = open()
    const thursday = q<HTMLInputElement>(editor, '#repeat-weekday-4')
    thursday.checked = true
    thursday.dispatchEvent(new Event('change'))

    q<HTMLButtonElement>(editor, '.repeat-actions .text-button:not(.is-primary)').click()
    await expect(result).resolves.toBeNull()
  })

  it('hands back the rule on Save, carrying only the fields its frequency uses', async () => {
    const { editor, result } = open()
    const freq = q<HTMLSelectElement>(editor, '#repeat-freq')
    freq.value = 'monthly'
    freq.dispatchEvent(new Event('change'))

    const nth = q<HTMLInputElement>(editor, '#repeat-monthly-nth')
    nth.checked = true
    nth.dispatchEvent(new Event('change'))

    q<HTMLButtonElement>(editor, '.repeat-actions .text-button.is-primary').click()

    const fields = await result
    expect(fields).toMatchObject({
      freq: 'monthly',
      interval: 1,
      starts: '2026-01-05',
      byNthWeekday: { nth: 1, weekday: 1 },
    })
    expect(fields).not.toHaveProperty('byWeekday')
    expect(fields).not.toHaveProperty('byMonthDay')
  })

  it('offers "stop repeating" only when there is a repeat to stop', async () => {
    const { editor, result } = open()
    expect(q<HTMLButtonElement>(editor, '.repeat-foot .is-danger').hidden).toBe(true)
    q<HTMLButtonElement>(editor, '.repeat-actions .text-button:not(.is-primary)').click()
    await result

    const rule: Recurrence = {
      id: 'r1',
      freq: 'daily',
      interval: 1,
      starts: '2026-01-05',
      weekStart: 1,
      ends: { type: 'never' },
      exceptions: [],
    }
    const second = open(rule)
    expect(q<HTMLButtonElement>(second.editor, '.repeat-foot .is-danger').hidden).toBe(false)
    q<HTMLButtonElement>(second.editor, '.repeat-foot .is-danger').click()
    await expect(second.result).resolves.toBe('remove')
  })
})
