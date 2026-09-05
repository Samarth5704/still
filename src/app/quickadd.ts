/**
 * Quick add.
 *
 * The primary input, focusable from anywhere with `/`. Everything it knows
 * about the grammar comes from `lib/parse.ts`; this module's whole job is to
 * show what the parser understood, before the user commits to it.
 *
 * That preview is not decoration. Inline parsing is only trustworthy if it is
 * visible: "next tue" is ambiguous until the app says which Tuesday it means.
 */
import { el, reconcile, setText } from './dom.ts'
import { icon } from './icons.ts'
import { isTitleEmpty, parseQuickAdd } from '../lib/parse.ts'
import type { ParsedInput, ParsedToken } from '../lib/parse.ts'
import type { ISODate, WeekStart } from '../lib/types.ts'

const TOKEN_ICON = {
  date: 'calendar',
  time: 'clock',
  priority: 'alert',
  project: 'circle',
  tag: 'tag',
  recurrence: 'repeat',
} as const

const TOKEN_NOUN: Record<ParsedToken['kind'], string> = {
  date: 'Due',
  time: 'At',
  priority: 'Priority',
  project: 'Project',
  tag: 'Tag',
  recurrence: 'Repeats',
}

export class QuickAdd {
  readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly preview: HTMLElement
  private readonly chips: HTMLElement
  private readonly hint: HTMLElement
  private parsed: ParsedInput | null = null
  private readonly onSubmit: (parsed: ParsedInput) => void
  private context: { today: ISODate; weekStart: WeekStart }

  constructor(
    onSubmit: (parsed: ParsedInput) => void,
    context: { today: ISODate; weekStart: WeekStart },
  ) {
    this.onSubmit = onSubmit
    this.context = context

    this.input = el('input', {
      class: 'quick-add-input',
      type: 'text',
      id: 'quick-add',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'Add a task — try "essay tomorrow !! #uni"',
      'aria-describedby': 'quick-add-preview',
    })

    this.chips = el('div', { class: 'preview-chips' })
    this.hint = el('span', { class: 'preview-hint' })
    // Not a live region: it updates on every keystroke, and announcing that
    // would be unusable. It is described-by instead, so it is read on demand.
    this.preview = el('div', { class: 'quick-add-preview', id: 'quick-add-preview' }, [this.hint, this.chips])

    const submit = el('button', { class: 'quick-add-submit', type: 'submit', 'aria-label': 'Add task' }, [
      icon('plus'),
    ])

    const form = el('form', { class: 'quick-add-form' }, [
      el('label', { class: 'sr-only', for: 'quick-add' }, ['Add a task']),
      this.input,
      submit,
    ])

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      this.commit()
    })

    this.input.addEventListener('input', () => this.update())
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.input.value = ''
        this.update()
        this.input.blur()
      }
    })

    this.root = el('div', { class: 'quick-add glass' }, [form, this.preview])
    this.update()
  }

  setContext(context: { today: ISODate; weekStart: WeekStart }): void {
    this.context = context
    this.update()
  }

  focus(): void {
    this.input.focus()
    this.input.select()
  }

  /** True when the caret is in this field, so `/` can be typed literally. */
  hasFocus(): boolean {
    return document.activeElement === this.input
  }

  private update(): void {
    const raw = this.input.value
    this.parsed = raw.trim() === '' ? null : parseQuickAdd(raw, this.context)

    if (!this.parsed) {
      setText(this.hint, 'Press / to focus. Type a date, #project, @tag or "every monday".')
      reconcile(this.chips, [])
      this.preview.classList.remove('is-active')
      return
    }

    this.preview.classList.add('is-active')

    const title = this.parsed.title
    setText(
      this.hint,
      isTitleEmpty(this.parsed) ? 'Needs a title' : title,
    )
    this.hint.classList.toggle('is-warning', isTitleEmpty(this.parsed))

    reconcile(
      this.chips,
      this.parsed.tokens.map((token) =>
        el('span', { class: 'chip chip-parsed', 'data-kind': token.kind }, [
          icon(TOKEN_ICON[token.kind]),
          el('span', { class: 'sr-only' }, [`${TOKEN_NOUN[token.kind]}: `]),
          token.label,
        ]),
      ),
    )
  }

  private commit(): void {
    if (!this.parsed || isTitleEmpty(this.parsed)) {
      this.input.focus()
      return
    }
    this.onSubmit(this.parsed)
    this.input.value = ''
    this.update()
    this.input.focus()
  }
}
