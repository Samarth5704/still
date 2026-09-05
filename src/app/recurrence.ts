/**
 * The recurrence editor.
 *
 * ### Why this one has a Cancel
 *
 * Every other dialog in this app saves as you go, and Phase 4 made that a rule:
 * the close button, Done, Escape and a backdrop click all dismiss without
 * discarding, because there is never anything to discard. This dialog is the
 * exception the rule anticipated, and it says so out loud in its own footer.
 *
 * A rule is built out of parts that are only meaningful together. Halfway
 * through turning "every Monday" into "the last Friday of every month" the
 * draft is a monthly rule with a weekday set and no month day — a rule nobody
 * asked for, which would nonetheless have to be saved, generated from, and
 * shown on the task behind. Worse, committing each control as it changes would
 * fire the scope question ("this occurrence, this and future, or the series?")
 * once per control.
 *
 * So this holds its own draft, commits nothing until Save, and offers a Cancel
 * that genuinely throws the draft away. It resolves a promise rather than
 * writing to the store: deciding what a new rule *means* for an existing series
 * is the store's job, not this dialog's.
 *
 * ### Why the preview is not decoration
 *
 * Recurrence is the one part of a todo app where users are routinely wrong
 * about what they just built — "every 2 weeks on Tuesday and Thursday" has a
 * week parity you cannot see, and "the 31st" has months where it does not
 * exist. The sentence and the next five dates are how the rule is checked
 * before it is trusted, so both update on every keystroke, from the same
 * functions the rest of the app reads the rule with.
 */
import { el, reconcile, restoreFocus, setClass, setText } from './dom.ts'
import { icon } from './icons.ts'
import { addDays, formatLongDate, isISODate, maxDate, parseISODate, weekday } from '../lib/dates.ts'
import { describeRule, previewOccurrences } from '../lib/series.ts'
import type { RuleFields } from '../lib/series.ts'
import type { ISODate, Recurrence, RecurrenceEnd, WeekStart } from '../lib/types.ts'

const FREQUENCIES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
] as const

type Freq = (typeof FREQUENCIES)[number]['value']

const UNITS: Record<Freq, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const NTHS = [
  { value: '1', label: 'first' },
  { value: '2', label: 'second' },
  { value: '3', label: 'third' },
  { value: '4', label: 'fourth' },
  { value: '-1', label: 'last' },
]

/** How many occurrences the preview shows. Five is enough to spot a wrong parity. */
const PREVIEW_COUNT = 5

/**
 * Every control's value, flattened.
 *
 * Deliberately not a `Recurrence`: the by-date and by-nth-weekday choices for a
 * monthly rule are mutually exclusive in the rule but both need remembering
 * here, so that flipping between them and back does not lose what was typed.
 */
type Draft = {
  freq: Freq
  interval: number
  byWeekday: number[]
  monthlyMode: 'day' | 'nth'
  byMonthDay: number
  nth: number
  nthWeekday: number
  byMonth: number
  starts: ISODate
  weekStart: WeekStart
  endKind: 'never' | 'after' | 'until'
  count: number
  until: ISODate
}

export type EditorRequest = {
  /** The rule being edited, or null when the task does not repeat yet. */
  rule: Recurrence | null
  today: ISODate
  /** Seeds a new rule's start date and its WKST. */
  due: ISODate | null
  weekStart: WeekStart
  /** Where focus goes if the control that opened this is gone by the time it closes. */
  focusFallbacks?: (() => HTMLElement | null)[]
}

/** Save hands back the rule; `'remove'` is the "does not repeat" answer; null is Cancel. */
export type EditorResult = RuleFields | 'remove' | null

function draftFrom(request: EditorRequest): Draft {
  const rule = request.rule
  const starts = rule?.starts ?? request.due ?? request.today
  // `Date` lives in lib/dates.ts and nowhere else; this reads the parts through it.
  const weekdayOfStart = weekday(starts)
  const { m: monthOfStart, d: dayOfStart } = parseISODate(starts)

  return {
    freq: rule?.freq ?? 'weekly',
    interval: rule?.interval ?? 1,
    byWeekday: rule?.byWeekday?.length ? [...rule.byWeekday] : [weekdayOfStart],
    monthlyMode: rule?.byNthWeekday ? 'nth' : 'day',
    byMonthDay: rule?.byMonthDay ?? dayOfStart,
    nth: rule?.byNthWeekday?.nth ?? 1,
    nthWeekday: rule?.byNthWeekday?.weekday ?? weekdayOfStart,
    byMonth: rule?.byMonth ?? monthOfStart,
    starts,
    weekStart: rule?.weekStart ?? request.weekStart,
    endKind: rule?.ends.type ?? 'never',
    count: rule?.ends.type === 'after' ? rule.ends.count : 10,
    until: rule?.ends.type === 'until' ? rule.ends.date : addDays(starts, 90),
  }
}

function endFrom(draft: Draft): RecurrenceEnd {
  if (draft.endKind === 'after') return { type: 'after', count: draft.count }
  if (draft.endKind === 'until') return { type: 'until', date: draft.until }
  return { type: 'never' }
}

/**
 * The draft as a rule, carrying only the fields its frequency actually uses.
 * A monthly rule holding a leftover `byWeekday` would be a field the generator
 * ignores today and might not ignore tomorrow.
 */
export function fieldsFrom(draft: Draft): RuleFields {
  const fields: RuleFields = {
    freq: draft.freq,
    interval: Math.max(1, Math.trunc(draft.interval)),
    starts: draft.starts,
    weekStart: draft.weekStart,
    ends: endFrom(draft),
  }
  if (draft.freq === 'weekly') fields.byWeekday = [...draft.byWeekday].sort((a, b) => a - b)
  if (draft.freq === 'monthly') {
    if (draft.monthlyMode === 'nth') fields.byNthWeekday = { nth: draft.nth, weekday: draft.nthWeekday }
    else fields.byMonthDay = draft.byMonthDay
  }
  if (draft.freq === 'yearly') {
    fields.byMonth = draft.byMonth
    fields.byMonthDay = draft.byMonthDay
  }
  return fields
}

/** What is wrong with the draft, in the user's words, or null when nothing is. */
export function validate(draft: Draft): string | null {
  if (!Number.isFinite(draft.interval) || draft.interval < 1) {
    return 'Repeat every one unit at least — an interval of zero never comes round.'
  }
  if (draft.freq === 'weekly' && draft.byWeekday.length === 0) {
    return 'Pick at least one day of the week.'
  }
  if (!isISODate(draft.starts)) return 'Give the repeat a start date.'
  if (draft.endKind === 'after' && (!Number.isFinite(draft.count) || draft.count < 1)) {
    return 'A repeat that runs zero times is not a repeat.'
  }
  if (draft.endKind === 'until') {
    if (!isISODate(draft.until)) return 'Give the repeat an end date.'
    if (draft.until < draft.starts) return 'The end date is before the start date.'
  }
  return null
}

export class RecurrenceEditor {
  readonly root: HTMLDialogElement

  private draft: Draft = draftFrom({ rule: null, today: '2000-01-01', due: null, weekStart: 1 })
  private today: ISODate = '2000-01-01'
  private existing: Recurrence | null = null
  private settle: ((result: EditorResult) => void) | null = null
  private done = false
  private returnFocus: HTMLElement | null = null
  private fallbacks: (() => HTMLElement | null)[] = []

  private readonly freq: HTMLSelectElement
  private readonly interval: HTMLInputElement
  private readonly intervalUnit: HTMLElement
  private readonly weekdayRow: HTMLElement
  private readonly weekdayInputs = new Map<number, HTMLInputElement>()
  private readonly monthlyRow: HTMLElement
  private readonly monthlyMode = new Map<'day' | 'nth', HTMLInputElement>()
  private readonly monthDay: HTMLInputElement
  private readonly nth: HTMLSelectElement
  private readonly nthWeekday: HTMLSelectElement
  private readonly yearlyRow: HTMLElement
  private readonly month: HTMLSelectElement
  private readonly yearDay: HTMLInputElement
  private readonly starts: HTMLInputElement
  private readonly endInputs = new Map<Draft['endKind'], HTMLInputElement>()
  private readonly count: HTMLInputElement
  private readonly until: HTMLInputElement
  private readonly summary: HTMLElement
  private readonly preview: HTMLUListElement
  private readonly previewNote: HTMLElement
  private readonly error: HTMLElement
  private readonly save: HTMLButtonElement
  private readonly remove: HTMLButtonElement

  constructor() {
    this.freq = el('select', { class: 'detail-select', id: 'repeat-freq' })
    for (const option of FREQUENCIES) {
      this.freq.append(el('option', { value: option.value }, [option.label]))
    }
    this.freq.addEventListener('change', () => {
      this.draft.freq = this.freq.value as Freq
      this.refresh()
    })

    this.interval = el('input', {
      class: 'detail-date repeat-number',
      type: 'number',
      min: 1,
      max: 999,
      id: 'repeat-interval',
    })
    this.interval.addEventListener('input', () => {
      this.draft.interval = this.interval.valueAsNumber
      this.refresh()
    })
    this.intervalUnit = el('span', { class: 'repeat-unit' })

    // ---- weekly ----------------------------------------------------------

    this.weekdayRow = el('div', { class: 'field' }, [
      el('span', { class: 'field-label', id: 'repeat-weekdays-label' }, ['On these days']),
    ])
    const weekdaySet = el('div', {
      class: 'weekday-set',
      role: 'group',
      'aria-labelledby': 'repeat-weekdays-label',
    })
    for (let day = 0; day < 7; day += 1) {
      const id = `repeat-weekday-${day}`
      const input = el('input', { class: 'sr-only weekday-input', type: 'checkbox', id })
      input.addEventListener('change', () => {
        this.draft.byWeekday = input.checked
          ? [...this.draft.byWeekday, day]
          : this.draft.byWeekday.filter((d) => d !== day)
        this.refresh()
      })
      this.weekdayInputs.set(day, input)
      weekdaySet.append(
        input,
        el('label', { class: 'weekday-label', for: id }, [
          el('span', { 'aria-hidden': 'true' }, [WEEKDAY_SHORT[day]!]),
          el('span', { class: 'sr-only' }, [WEEKDAY_LONG[day]!]),
        ]),
      )
    }
    this.weekdayRow.append(weekdaySet)

    // ---- monthly ---------------------------------------------------------

    this.monthDay = el('input', {
      class: 'detail-date repeat-number',
      type: 'number',
      min: 1,
      max: 31,
      id: 'repeat-month-day',
      'aria-label': 'Day of the month',
    })
    this.monthDay.addEventListener('input', () => {
      this.draft.byMonthDay = this.monthDay.valueAsNumber
      this.refresh()
    })

    this.nth = el('select', { class: 'detail-select', 'aria-label': 'Which week' })
    for (const option of NTHS) this.nth.append(el('option', { value: option.value }, [option.label]))
    this.nth.addEventListener('change', () => {
      this.draft.nth = Number(this.nth.value)
      this.refresh()
    })

    this.nthWeekday = el('select', { class: 'detail-select', 'aria-label': 'Which day' })
    for (let day = 0; day < 7; day += 1) {
      this.nthWeekday.append(el('option', { value: String(day) }, [WEEKDAY_LONG[day]!]))
    }
    this.nthWeekday.addEventListener('change', () => {
      this.draft.nthWeekday = Number(this.nthWeekday.value)
      this.refresh()
    })

    const modeRows: HTMLElement[] = []
    for (const mode of ['day', 'nth'] as const) {
      const id = `repeat-monthly-${mode}`
      const input = el('input', {
        class: 'repeat-radio',
        type: 'radio',
        name: 'repeat-monthly-mode',
        id,
      })
      input.addEventListener('change', () => {
        if (!input.checked) return
        this.draft.monthlyMode = mode
        this.refresh()
      })
      this.monthlyMode.set(mode, input)
      modeRows.push(
        el('div', { class: 'repeat-choice' }, [
          input,
          el('label', { class: 'repeat-choice-label', for: id }, [
            mode === 'day' ? 'On day' : 'On the',
          ]),
          ...(mode === 'day' ? [this.monthDay] : [this.nth, this.nthWeekday]),
        ]),
      )
    }
    this.monthlyRow = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Which day']),
      ...modeRows,
    ])

    // ---- yearly ----------------------------------------------------------

    this.month = el('select', { class: 'detail-select', 'aria-label': 'Month' })
    for (let m = 1; m <= 12; m += 1) {
      this.month.append(el('option', { value: String(m) }, [MONTH_LONG[m - 1]!]))
    }
    this.month.addEventListener('change', () => {
      this.draft.byMonth = Number(this.month.value)
      this.refresh()
    })
    this.yearDay = el('input', {
      class: 'detail-date repeat-number',
      type: 'number',
      min: 1,
      max: 31,
      'aria-label': 'Day of the month',
    })
    this.yearDay.addEventListener('input', () => {
      this.draft.byMonthDay = this.yearDay.valueAsNumber
      this.refresh()
    })
    this.yearlyRow = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['On']),
      el('div', { class: 'repeat-choice' }, [this.yearDay, this.month]),
    ])

    // ---- starts and ends -------------------------------------------------

    this.starts = el('input', { class: 'detail-date', type: 'date', id: 'repeat-starts' })
    this.starts.addEventListener('input', () => {
      if (isISODate(this.starts.value)) this.draft.starts = this.starts.value
      this.refresh()
    })

    this.count = el('input', {
      class: 'detail-date repeat-number',
      type: 'number',
      min: 1,
      max: 999,
      'aria-label': 'Number of times',
    })
    this.count.addEventListener('input', () => {
      this.draft.count = this.count.valueAsNumber
      this.refresh()
    })

    this.until = el('input', { class: 'detail-date', type: 'date', 'aria-label': 'Repeat until' })
    this.until.addEventListener('input', () => {
      if (isISODate(this.until.value)) this.draft.until = this.until.value
      this.refresh()
    })

    const endRows: HTMLElement[] = []
    const endLabels: Record<Draft['endKind'], string> = {
      never: 'Never',
      after: 'After',
      until: 'On',
    }
    for (const kind of ['never', 'after', 'until'] as const) {
      const id = `repeat-end-${kind}`
      const input = el('input', { class: 'repeat-radio', type: 'radio', name: 'repeat-end', id })
      input.addEventListener('change', () => {
        if (!input.checked) return
        this.draft.endKind = kind
        this.refresh()
      })
      this.endInputs.set(kind, input)
      endRows.push(
        el('div', { class: 'repeat-choice' }, [
          input,
          el('label', { class: 'repeat-choice-label', for: id }, [endLabels[kind]]),
          ...(kind === 'after'
            ? [this.count, el('span', { class: 'repeat-unit' }, ['times'])]
            : kind === 'until'
              ? [this.until]
              : []),
        ]),
      )
    }

    // ---- readback --------------------------------------------------------

    this.summary = el('p', { class: 'repeat-summary', role: 'status' })
    this.preview = el('ul', { class: 'repeat-preview' })
    this.previewNote = el('p', { class: 'field-hint' })
    this.error = el('p', { class: 'manage-error', role: 'alert' })
    this.error.hidden = true

    // ---- frame -----------------------------------------------------------

    const close = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Cancel' }, [
      icon('close'),
    ])
    close.addEventListener('click', () => this.finish(null))

    this.save = el('button', { class: 'text-button is-primary', type: 'button' }, ['Save repeat'])
    this.save.addEventListener('click', () => {
      if (validate(this.draft) !== null) return
      this.finish(fieldsFrom(this.draft))
    })

    const cancel = el('button', { class: 'text-button', type: 'button' }, ['Cancel'])
    cancel.addEventListener('click', () => this.finish(null))

    this.remove = el('button', { class: 'text-button is-danger', type: 'button' }, [
      'Stop repeating',
    ])
    this.remove.addEventListener('click', () => this.finish('remove'))

    this.root = el('dialog', { class: 'repeat-editor glass', 'aria-labelledby': 'repeat-heading' }, [
      el('div', { class: 'detail-head' }, [
        el('h2', { class: 'manage-heading', id: 'repeat-heading' }, ['Repeat']),
        close,
      ]),
      el('div', { class: 'detail-body' }, [
        el('div', { class: 'field-row' }, [
          el('div', { class: 'field' }, [
            el('label', { class: 'field-label', for: 'repeat-freq' }, ['Frequency']),
            this.freq,
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'field-label', for: 'repeat-interval' }, ['Every']),
            el('div', { class: 'repeat-choice' }, [this.interval, this.intervalUnit]),
          ]),
        ]),
        this.weekdayRow,
        this.monthlyRow,
        this.yearlyRow,
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', for: 'repeat-starts' }, ['Starts']),
          this.starts,
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, ['Ends']),
          ...endRows,
        ]),
        this.error,
        el('div', { class: 'repeat-readback' }, [
          this.summary,
          el('span', { class: 'field-label' }, ['Next occurrences']),
          this.preview,
          this.previewNote,
        ]),
      ]),
      el('div', { class: 'detail-foot repeat-foot' }, [
        this.remove,
        // The one dialog in this app that can lose work, saying so where the
        // Cancel button is rather than leaving anyone to find out.
        el('span', { class: 'detail-hint' }, ['Cancel discards this repeat']),
        el('div', { class: 'repeat-actions' }, [cancel, this.save]),
      ]),
    ])

    this.root.addEventListener('close', () => this.finish(null))
  }

  get isOpen(): boolean {
    return this.root.open
  }

  /** Open on `request`'s rule and resolve with what the user decided. */
  open(request: EditorRequest): Promise<EditorResult> {
    this.draft = draftFrom(request)
    this.today = request.today
    this.existing = request.rule
    this.fallbacks = request.focusFallbacks ?? []
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.done = false

    this.remove.hidden = request.rule === null
    this.writeControls()
    this.refresh()
    this.root.showModal()
    this.root.querySelector<HTMLElement>('.detail-body')!.scrollTop = 0
    this.freq.focus()

    return new Promise<EditorResult>((resolve) => {
      this.settle = resolve
    })
  }

  private finish(result: EditorResult): void {
    if (this.done) return
    this.done = true
    if (this.root.open) this.root.close()
    // The detail dialog underneath is still modal, so a fallback outside it
    // would be inert and would silently refuse the focus.
    restoreFocus(this.returnFocus, ...this.fallbacks)
    const settle = this.settle
    this.settle = null
    settle?.(result)
  }

  /** Push the draft into the controls. Only on open: after that the user owns them. */
  private writeControls(): void {
    const draft = this.draft
    this.freq.value = draft.freq
    this.interval.value = String(draft.interval)
    for (const [day, input] of this.weekdayInputs) input.checked = draft.byWeekday.includes(day)
    this.monthlyMode.get(draft.monthlyMode)!.checked = true
    this.monthDay.value = String(draft.byMonthDay)
    this.nth.value = String(draft.nth)
    this.nthWeekday.value = String(draft.nthWeekday)
    this.month.value = String(draft.byMonth)
    this.yearDay.value = String(draft.byMonthDay)
    this.starts.value = draft.starts
    this.endInputs.get(draft.endKind)!.checked = true
    this.count.value = String(draft.count)
    this.until.value = draft.until
  }

  /** Re-derive everything the draft implies: visibility, validity, prose, preview. */
  private refresh(): void {
    const draft = this.draft
    this.weekdayRow.hidden = draft.freq !== 'weekly'
    this.monthlyRow.hidden = draft.freq !== 'monthly'
    this.yearlyRow.hidden = draft.freq !== 'yearly'

    const plural = draft.interval > 1
    setText(this.intervalUnit, UNITS[draft.freq][plural ? 1 : 0])
    this.count.disabled = draft.endKind !== 'after'
    this.until.disabled = draft.endKind !== 'until'
    this.monthDay.disabled = draft.monthlyMode !== 'day'
    this.nth.disabled = draft.monthlyMode !== 'nth'
    this.nthWeekday.disabled = draft.monthlyMode !== 'nth'

    const problem = validate(draft)
    this.error.hidden = problem === null
    if (problem !== null) setText(this.error, problem)
    this.save.disabled = problem !== null
    setClass(this.root, 'is-invalid', problem !== null)

    if (problem !== null) {
      setText(this.summary, 'Not a repeat yet.')
      reconcile(this.preview, [])
      setText(this.previewNote, '')
      return
    }

    // Preview against the real rule, exceptions and all, so a series with
    // occurrences already skipped previews what will actually happen next.
    const rule: Recurrence = {
      ...fieldsFrom(draft),
      id: this.existing?.id ?? 'draft',
      exceptions: this.existing?.exceptions ?? [],
    }
    setText(this.summary, describeRule(rule))

    const from = maxDate(rule.starts, this.today)
    const next = previewOccurrences(rule, from, PREVIEW_COUNT)
    reconcile(
      this.preview,
      next.map((occurrence) =>
        el('li', {}, [
          el('span', { class: 'repeat-preview-date' }, [
            formatLongDate(occurrence.date, this.today),
          ]),
          el('span', { class: 'repeat-preview-day' }, [
            WEEKDAY_LONG[weekday(occurrence.date)]!,
          ]),
        ]),
      ),
    )
    setText(
      this.previewNote,
      next.length === 0
        ? 'This rule produces nothing from today onward.'
        : next.length < PREVIEW_COUNT
          ? 'That is the whole of what is left.'
          : '',
    )
  }
}
