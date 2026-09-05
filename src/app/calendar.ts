/**
 * The calendar: a month grid, an agenda, and the day they are both pointing at.
 *
 * Everything it draws comes from `lib/calendar.ts`, which pulls occurrences out
 * of the rules for exactly the window on screen — a repeating task's other
 * dates are not rows in `state.tasks` and cannot be found by looking there.
 *
 * ### Focus and selection are two different things
 *
 * The grid follows the date-grid convention every calendar control follows:
 * arrow keys move *focus* between days without committing to anything, and
 * Enter or Space *selects* the focused day, which is what filters the list
 * below and writes the day into the URL. Selecting on every arrow key would
 * push a history entry per keystroke and re-announce the list seven times
 * crossing a week; moving focus silently would leave a keyboard user unable to
 * tell where they are, so each focus move announces the day it landed on
 * instead.
 *
 * Selection lives in the view, not in this component, so a day someone is
 * looking at can be linked. Focus, the month on show and the month/agenda
 * choice live here, because none of them is a place — they are where you have
 * got to while looking at one.
 */
import { el, reconcile, restoreFocus, setAttr, setClass, setText } from './dom.ts'
import { icon } from './icons.ts'
import {
  agendaIn,
  calendarWindow,
  dayDetail,
  dayHeading,
  dayIn,
  dayLoadLabel,
  firstOfMonth,
  monthGridIn,
  monthTitle,
  monthWindowFor,
  stepDate,
} from '../lib/calendar.ts'
import { addMonths, daysInMonth, formatISODate, parseISODate } from '../lib/dates.ts'
import { timeLabel } from '../lib/views.ts'
import type { CalendarDay, CalendarEntry, CalendarWindow } from '../lib/calendar.ts'
import type { ISODate, Priority, State, WeekStart } from '../lib/types.ts'

/** How many task names a month cell shows before it says "and N more". */
const CELL_ENTRIES = 3

const PRIORITY_WORD: Record<Priority, string> = {
  none: '',
  low: 'low priority',
  medium: 'medium priority',
  high: 'high priority',
  urgent: 'urgent',
}

const STATUS_WORD: Record<CalendarEntry['status'], string> = {
  pending: '',
  completed: 'completed',
  skipped: 'skipped',
  moved: 'moved to this day',
}

export type CalendarHandlers = {
  /** A day was chosen. The app owns the URL, so it decides what that means. */
  onSelectDay: (date: ISODate) => void
  onOpenTask: (taskId: string) => void
  onToggle: (taskId: string, origin: { x: number; y: number }) => void
  announce: (message: string) => void
}

type Cell = {
  td: HTMLTableCellElement
  num: HTMLElement
  body: HTMLElement
  signature: string
}

type AgendaRow = {
  li: HTMLLIElement
  button: HTMLButtonElement
  heading: HTMLElement
  load: HTMLElement
  list: HTMLUListElement
  signature: string
}

type EntryRow = {
  li: HTMLLIElement
  action: HTMLButtonElement
  mark: HTMLElement
  title: HTMLButtonElement
  meta: HTMLElement
  signature: string
}

/**
 * The agenda is the grid turned on its side, so its arrow keys are too: up and
 * down step a day, left and right step a week. Mapping the keys rather than
 * writing a second navigator keeps one definition of what Page Up does.
 */
const AGENDA_KEYS: Record<string, string> = {
  ArrowUp: 'ArrowLeft',
  ArrowDown: 'ArrowRight',
  ArrowLeft: 'ArrowUp',
  ArrowRight: 'ArrowDown',
}

export class Calendar {
  readonly root: HTMLElement

  private readonly handlers: CalendarHandlers
  private readonly title: HTMLElement
  private readonly grid: HTMLTableElement
  private readonly headRow: HTMLTableRowElement
  private readonly gridBody: HTMLTableSectionElement
  private readonly cells: Cell[] = []
  private readonly agenda: HTMLUListElement
  private readonly agendaRows = new Map<ISODate, AgendaRow>()
  private readonly dayHeading: HTMLElement
  private readonly dayLoad: HTMLElement
  private readonly dayList: HTMLUListElement
  private readonly dayEmpty: HTMLElement
  private readonly entryRows = new Map<string, EntryRow>()
  private readonly modeButtons: { mode: 'month' | 'agenda'; button: HTMLButtonElement }[] = []

  private mode: 'month' | 'agenda' = 'month'
  private month: ISODate | null = null
  private focus: ISODate | null = null
  /** Set when a key or a control moved focus and the DOM has not caught up yet. */
  private takeFocus = false

  constructor(handlers: CalendarHandlers) {
    this.handlers = handlers

    this.title = el('h2', { class: 'cal-title', id: 'cal-title' })

    const prev = this.stepButton('chevron-left', 'Previous month', -1)
    const next = this.stepButton('chevron-right', 'Next month', 1)

    const today = el('button', { class: 'cal-today', type: 'button' }, ['Today'])
    today.addEventListener('click', () => {
      const date = this.todayDate
      this.month = firstOfMonth(date)
      this.moveFocus(date, { announce: false })
      this.handlers.onSelectDay(date)
    })

    for (const mode of ['month', 'agenda'] as const) {
      const button = el('button', { class: 'cal-mode', type: 'button' }, [
        mode === 'month' ? 'Month' : 'Agenda',
      ])
      button.addEventListener('click', () => this.setMode(mode))
      this.modeButtons.push({ mode, button })
    }

    this.headRow = el('tr', { role: 'row' })
    this.gridBody = el('tbody', { role: 'rowgroup' })
    this.grid = el(
      'table',
      { class: 'cal-grid', role: 'grid', 'aria-labelledby': 'cal-title' },
      [el('thead', { role: 'rowgroup' }, [this.headRow]), this.gridBody],
    )

    for (let w = 0; w < 6; w += 1) {
      const tr = el('tr', { role: 'row' })
      for (let d = 0; d < 7; d += 1) tr.append(this.createCell().td)
      this.gridBody.append(tr)
    }

    this.grid.addEventListener('keydown', (event) => this.onKeydown(event, 'month'))

    this.agenda = el('ul', { class: 'cal-agenda' })
    this.agenda.addEventListener('keydown', (event) => this.onKeydown(event, 'agenda'))

    this.dayHeading = el('h3', { class: 'cal-day-title', id: 'cal-day-title', tabindex: '-1' })
    this.dayLoad = el('p', { class: 'cal-day-load' })
    this.dayList = el('ul', { class: 'cal-day-list', 'aria-labelledby': 'cal-day-title' })
    this.dayEmpty = el('p', { class: 'cal-day-empty' }, ['Nothing scheduled. A quiet day is information too.'])

    this.root = el('div', { class: 'calendar' }, [
      el('div', { class: 'cal-head' }, [
        el('div', { class: 'cal-nav' }, [prev, this.title, next, today]),
        el('div', { class: 'cal-modes', role: 'group', 'aria-label': 'Calendar layout' },
          this.modeButtons.map((m) => m.button)),
      ]),
      el('div', { class: 'cal-body glass' }, [this.grid, this.agenda]),
      el('section', { class: 'cal-day glass', 'aria-labelledby': 'cal-day-title' }, [
        this.dayHeading,
        this.dayLoad,
        this.dayList,
        this.dayEmpty,
      ]),
    ])
  }

  private stepButton(name: 'chevron-left' | 'chevron-right', label: string, delta: -1 | 1) {
    const button = el('button', { class: 'icon-button cal-step', type: 'button', 'aria-label': label }, [
      icon(name),
    ])
    button.addEventListener('click', () => {
      const month = addMonths(this.month ?? this.todayDate, delta)
      this.month = firstOfMonth(month)
      // Keep the day-of-month where it was, clamped — stepping from the 31st
      // must not land on nothing.
      const { d } = parseISODate(this.focus ?? this.todayDate)
      const { y, m } = parseISODate(this.month)
      this.moveFocus(formatISODate(y, m, Math.min(d, daysInMonth(y, m))), { announce: false })
      this.handlers.announce(monthTitle(this.month))
    })
    return button
  }

  /**
   * Today, as of the last render. Every control that reads it — the Today
   * button, a month step — is unreachable before the first render, so the
   * fallback is unreachable too; it exists so the getter has no `!`.
   */
  private get todayDate(): ISODate {
    return this.lastToday ?? this.focus ?? '2000-01-01'
  }

  private lastToday: ISODate | null = null

  // ---- mode and focus ------------------------------------------------------

  private setMode(mode: 'month' | 'agenda'): void {
    if (this.mode === mode) return
    this.mode = mode
    this.takeFocus = true
    this.rerender()
    this.handlers.announce(mode === 'month' ? 'Month grid' : 'Agenda')
  }

  private moveFocus(date: ISODate, opts: { announce: boolean }): void {
    this.focus = date
    // Following focus off the edge of the grid turns the page, which is what
    // makes Page Down and a run of arrow presses both work without a second
    // control.
    if (this.month === null || date.slice(0, 7) !== this.month.slice(0, 7)) {
      this.month = firstOfMonth(date)
    }
    this.takeFocus = true
    this.rerender()
    if (opts.announce) this.handlers.announce(this.focusSummary())
  }

  private focusSummary(): string {
    if (!this.focus || !this.lastState || !this.lastToday) return ''
    // Called straight after the re-render that moved focus, so the window is
    // current and holds the day: an arrow key costs no extra walk.
    const day =
      (this.window && dayIn(this.window, this.focus)) ??
      dayDetail(this.lastState, this.focus, this.lastToday, { weekStart: this.weekStart })
    return `${dayHeading(day.date, this.lastToday)}. ${dayLoadLabel(day)}`
  }

  private onKeydown(event: KeyboardEvent, mode: 'month' | 'agenda'): void {
    const from = this.focus
    if (from === null) return

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.handlers.onSelectDay(from)
      return
    }

    const key = mode === 'agenda' ? (AGENDA_KEYS[event.key] ?? event.key) : event.key
    const to = stepDate(from, key, this.weekStart, event.shiftKey)
    if (to === null) return
    event.preventDefault()
    this.moveFocus(to, { announce: true })
  }

  // ---- rendering -----------------------------------------------------------

  private lastState: State | null = null
  /** The one fetch the current render is shaped from. */
  private window: CalendarWindow | null = null
  private weekStart: WeekStart = 1
  private lastSelected: ISODate | null = null

  private rerender(): void {
    if (this.lastState && this.lastToday) {
      this.render(this.lastState, this.lastToday, this.weekStart, this.lastSelected)
    }
  }

  render(state: State, today: ISODate, weekStart: WeekStart, selected: ISODate | null): void {
    const previous = this.lastSelected
    const first = this.lastState === null

    this.lastState = state
    this.lastToday = today
    this.weekStart = weekStart
    this.lastSelected = selected

    const day = selected ?? today
    /*
     * A day arriving from outside — the first render, or a new day in the URL —
     * is where focus belongs. After that the two move independently, and the
     * comparison has to be against the *previous* selection rather than against
     * the focused day: comparing with the focus is how every arrow key gets
     * snapped straight back to the selected day, which leaves the grid looking
     * like it has no keyboard navigation at all.
     */
    if (this.focus === null || first || selected !== previous) {
      this.focus = day
    }
    // The month on show always contains the focused day, so there is always
    // exactly one cell in the tab order.
    if (this.month === null || this.focus.slice(0, 7) !== this.month.slice(0, 7)) {
      this.month = firstOfMonth(this.focus)
    }

    /*
     * ONE fetch per render. The grid, the agenda and the day panel all want the
     * same days, and `entriesBetween` walks every rule in the state — so three
     * calls would triple that walk, and the one-day panel would pay the full
     * per-rule cost for a single square. The window is six weeks plus a margin
     * either side, which is why paging a month costs one walk and not one per
     * cell.
     */
    const { start, end } = monthWindowFor(this.month, weekStart)
    this.window = calendarWindow(state, start, end, today, { weekStart })

    const grid = monthGridIn(this.window, this.month, weekStart)
    setText(this.title, grid.title)

    this.grid.hidden = this.mode !== 'month'
    this.agenda.hidden = this.mode !== 'agenda'
    for (const { mode, button } of this.modeButtons) {
      setAttr(button, 'aria-pressed', mode === this.mode ? 'true' : 'false')
      setClass(button, 'is-current', mode === this.mode)
    }

    if (this.mode === 'month') this.renderGrid(grid.weeks.flatMap((w) => w.days), grid.weekdays, today, day)
    else this.renderAgenda(today, day)

    this.renderDay(state, day, today)

    if (this.takeFocus) {
      this.takeFocus = false
      /*
       * Scoped to the layout on show. Both layouts mark their focused day, and
       * the grid comes first in the document — so an unscoped query hands the
       * hidden one back, `.focus()` on a hidden node does nothing at all, and
       * focus silently stays on whatever was clicked. Connected is not the same
       * as focusable, which is why `restoreFocus` checks rather than assumes.
       */
      const host = this.mode === 'month' ? this.grid : this.agenda
      restoreFocus(host.querySelector<HTMLElement>('[data-focus-day]'))
    }
  }

  private createCell(): Cell {
    const num = el('span', { class: 'cal-num' })
    const body = el('span', { class: 'cal-cell-body' })
    const td = el('td', { class: 'cal-cell', role: 'gridcell', tabindex: '-1' }, [num, body])

    td.addEventListener('click', () => {
      const date = td.dataset.date
      if (date) {
        this.focus = date
        this.handlers.onSelectDay(date)
      }
    })
    // A cell that takes focus by pointer or by Tab must become the roving one,
    // or the next arrow key jumps back to wherever the model thought focus was.
    td.addEventListener('focus', () => {
      if (td.dataset.date && td.dataset.date !== this.focus) this.focus = td.dataset.date
    })

    const cell: Cell = { td, num, body, signature: '' }
    this.cells.push(cell)
    return cell
  }

  private renderGrid(
    days: CalendarDay[],
    weekdays: { short: string; long: string }[],
    today: ISODate,
    selected: ISODate,
  ): void {
    if (this.headRow.children.length !== 7) {
      this.headRow.replaceChildren(
        ...weekdays.map((w) =>
          el('th', { scope: 'col', role: 'columnheader', class: 'cal-weekday' }, [
            el('span', { 'aria-hidden': 'true' }, [w.short]),
            el('span', { class: 'sr-only' }, [w.long]),
          ]),
        ),
      )
    } else {
      // The week can be restarted on Sunday from settings; the headings follow.
      ;[...this.headRow.children].forEach((th, i) => {
        const w = weekdays[i]!
        setText(th.firstElementChild!, w.short)
        setText(th.lastElementChild!, w.long)
      })
    }

    days.forEach((day, i) => {
      const cell = this.cells[i]
      if (!cell) return
      const focused = day.date === this.focus
      const signature = [
        day.date,
        String(day.inMonth),
        String(day.isToday),
        String(day.date === selected),
        String(focused),
        day.entries.map((e) => `${e.key}${e.status}${e.overdue}`).join('|'),
      ].join(' ')
      if (cell.signature === signature) return
      cell.signature = signature

      cell.td.dataset.date = day.date
      setText(cell.num, String(day.dayOfMonth))
      setClass(cell.td, 'is-outside', !day.inMonth)
      setClass(cell.td, 'is-today', day.isToday)
      setClass(cell.td, 'is-weekend', day.isWeekend)
      setClass(cell.td, 'is-selected', day.date === selected)
      setClass(cell.td, 'has-overdue', day.overdue > 0)
      setAttr(cell.td, 'aria-selected', day.date === selected ? 'true' : 'false')
      setAttr(cell.td, 'aria-current', day.isToday && 'date')
      cell.td.tabIndex = focused ? 0 : -1
      setAttr(cell.td, 'data-focus-day', focused && '')
      setAttr(cell.td, 'aria-label', `${dayHeading(day.date, today)}. ${dayLoadLabel(day)}`)

      // Nothing inside a cell is focusable or animated — the cell itself is the
      // control — so rebuilding its contents behind a signature check costs
      // nothing a keyed reconcile would save.
      const shown = day.entries.slice(0, CELL_ENTRIES)
      const nodes: Element[] = shown.map((entry) =>
        el('span', { class: 'cal-pip', 'data-status': entry.status, 'data-priority': entry.priority }, [
          el('span', { class: 'cal-pip-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'cal-pip-title' }, [entry.title]),
        ]),
      )
      if (day.entries.length > shown.length) {
        nodes.push(
          el('span', { class: 'cal-more' }, [`+${day.entries.length - shown.length} more`]),
        )
      }
      cell.body.replaceChildren(...nodes)
    })
  }

  private renderAgenda(today: ISODate, selected: ISODate): void {
    const month = this.month ?? firstOfMonth(today)
    const { y, m } = parseISODate(month)
    // The month sits inside the six-week window by construction, so the agenda
    // is a second shape over the fetch the grid already paid for, not a second
    // walk over every rule.
    const days = agendaIn(this.window!, month, formatISODate(y, m, daysInMonth(y, m)))

    const desired: Element[] = []
    for (const day of days) desired.push(this.agendaRowFor(day, today, selected).li)
    reconcile(this.agenda, desired)

    for (const [date, row] of this.agendaRows) {
      if (!row.li.isConnected) this.agendaRows.delete(date)
    }
  }

  private agendaRowFor(day: CalendarDay, today: ISODate, selected: ISODate): AgendaRow {
    let row = this.agendaRows.get(day.date)
    if (!row) {
      const heading = el('span', { class: 'agenda-heading' })
      const load = el('span', { class: 'agenda-load' })
      const button = el('button', { class: 'agenda-day', type: 'button', tabindex: '-1' }, [
        heading,
        load,
      ])
      const list = el('ul', { class: 'agenda-entries' })
      const li = el('li', { class: 'agenda-row' }, [button, list])

      button.addEventListener('click', () => {
        this.focus = day.date
        this.handlers.onSelectDay(day.date)
      })
      button.addEventListener('focus', () => {
        this.focus = day.date
      })

      row = { li, button, heading, load, list, signature: '' }
      this.agendaRows.set(day.date, row)
    }

    const focused = day.date === this.focus
    const signature = [
      String(day.isToday),
      String(day.date === selected),
      String(focused),
      day.entries.map((e) => `${e.key}${e.status}${e.overdue}${e.title}`).join('|'),
      today,
    ].join(' ')
    if (row.signature === signature) return row
    row.signature = signature

    setText(row.heading, dayHeading(day.date, today))
    setText(row.load, dayLoadLabel(day))
    setClass(row.li, 'is-empty', day.entries.length === 0)
    setClass(row.li, 'is-today', day.isToday)
    setClass(row.li, 'is-selected', day.date === selected)
    setClass(row.li, 'has-overdue', day.overdue > 0)
    setAttr(row.button, 'aria-current', day.isToday && 'date')
    setAttr(row.button, 'aria-pressed', day.date === selected ? 'true' : 'false')
    row.button.tabIndex = focused ? 0 : -1
    setAttr(row.button, 'data-focus-day', focused && '')

    // Titles only here: the agenda's job is the shape of the month, and the
    // day panel below is where a task can actually be acted on.
    row.list.replaceChildren(
      ...day.entries.map((entry) =>
        el('li', { class: 'agenda-entry', 'data-status': entry.status }, [
          el('span', { class: 'cal-pip-dot', 'data-priority': entry.priority, 'aria-hidden': 'true' }),
          entry.title,
          entry.status !== 'pending'
            ? el('span', { class: 'agenda-status' }, [` — ${STATUS_WORD[entry.status]}`])
            : null,
        ]),
      ),
    )
    return row
  }

  // ---- the day's list ------------------------------------------------------

  private renderDay(state: State, date: ISODate, today: ISODate): void {
    // `dayIn` is free — the day is already in the window. The fallback is for a
    // date the window does not reach, which the focus/month invariant should
    // make unreachable; it is a fetch rather than an empty panel because being
    // wrong about that should cost a walk, not the day's contents.
    const day =
      (this.window && dayIn(this.window, date)) ??
      dayDetail(state, date, today, { weekStart: this.weekStart })
    setText(this.dayHeading, dayHeading(date, today))
    setText(this.dayLoad, dayLoadLabel(day))
    this.dayLoad.hidden = day.entries.length === 0
    this.dayEmpty.hidden = day.entries.length > 0
    this.dayList.hidden = day.entries.length === 0

    const desired: Element[] = []
    for (const entry of day.entries) desired.push(this.entryRowFor(entry, today).li)
    reconcile(this.dayList, desired)

    for (const [key, row] of this.entryRows) {
      if (!row.li.isConnected) this.entryRows.delete(key)
    }
  }

  private entryRowFor(entry: CalendarEntry, today: ISODate): EntryRow {
    let row = this.entryRows.get(entry.key)
    if (!row) {
      const action = el('button', { class: 'check', type: 'button' }, [icon('check', 'check-mark')])
      const mark = el('span', { class: 'cal-entry-mark', 'aria-hidden': 'true' })
      const title = el('button', { class: 'task-title', type: 'button' })
      const meta = el('div', { class: 'task-meta' })
      // The tick and the status mark share one column: exactly one of them is
      // ever showing, and a row whose title starts in a different place
      // depending on whether it can be ticked reads as two different lists.
      const li = el('li', { class: 'task cal-entry' }, [
        el('span', { class: 'cal-entry-lead' }, [action, mark]),
        el('div', { class: 'task-body' }, [title, meta]),
      ])

      const taskId = entry.taskId
      action.addEventListener('click', () => {
        const box = action.getBoundingClientRect()
        this.handlers.onToggle(taskId, { x: box.left + box.width / 2, y: box.top + box.height / 2 })
        // The row this button lives on is about to stop existing — the task
        // advances to its next occurrence, or leaves the day entirely — so
        // focus is handed on before the re-render can drop it on `<body>`.
        restoreFocus(null, () => this.dayHeading)
      })
      title.addEventListener('click', () => this.handlers.onOpenTask(taskId))

      row = { li, action, mark, title, meta, signature: '' }
      this.entryRows.set(entry.key, row)
    }

    const signature = [
      entry.title, entry.status, String(entry.actionable), String(entry.overdue),
      entry.dueTime ?? '', entry.priority, String(entry.repeats), today,
    ].join(' ')
    if (row.signature === signature) return row
    row.signature = signature

    setText(row.title, entry.title)
    setAttr(row.li, 'data-priority', entry.priority)
    setAttr(row.li, 'data-status', entry.status)
    setClass(row.li, 'is-overdue', entry.overdue)

    row.action.hidden = !entry.actionable
    row.mark.hidden = entry.actionable
    setAttr(row.action, 'aria-label', `Complete: ${entry.title}`)
    setAttr(row.title, 'aria-label', `Open: ${entry.title}`)

    if (!entry.actionable) {
      row.mark.replaceChildren(
        entry.status === 'completed'
          ? icon('check')
          : entry.status === 'skipped'
            ? icon('skip')
            : icon('repeat'),
      )
    }

    const chips: Element[] = []
    const time = timeLabel(entry.dueTime)
    if (time) chips.push(el('span', { class: 'chip chip-time' }, [icon('clock'), time]))
    if (entry.repeats) {
      chips.push(
        el('span', { class: 'chip chip-repeat' }, [icon('repeat'), el('span', { class: 'sr-only' }, ['repeats'])]),
      )
    }
    if (entry.overdue) {
      chips.push(el('span', { class: 'chip chip-due is-overdue' }, [icon('alert'), 'Overdue']))
    }
    // A status the checkbox is not showing has to be said in words, or a
    // completed occurrence and a forecast one look identical.
    if (!entry.actionable && STATUS_WORD[entry.status]) {
      chips.push(el('span', { class: 'chip chip-status' }, [STATUS_WORD[entry.status]!]))
    } else if (!entry.actionable) {
      chips.push(el('span', { class: 'chip chip-status' }, ['scheduled']))
    }
    if (entry.priority !== 'none' && PRIORITY_WORD[entry.priority]) {
      chips.push(el('span', { class: 'sr-only' }, [PRIORITY_WORD[entry.priority]!]))
    }
    reconcile(row.meta, chips)
    return row
  }
}
