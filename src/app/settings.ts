/**
 * Preferences.
 *
 * Three choices, and two of them have the same shape for the same reason:
 * `effects` and `theme` each offer a system-following default plus explicit
 * alternatives, and the explicit ones outrank the OS in BOTH directions. With
 * only "on" and "off" an explicit "on" cannot be told from a default "on", so
 * following the system setting would overrule someone who asked for motion and
 * ignoring it would overrule someone who asked for none. The fourth value is
 * what makes this a preference rather than a hint.
 *
 * Saves as you go, like everything else in this app except the recurrence
 * editor. There is no Apply and no Cancel: a radio you can see the effect of
 * the instant you press it does not need a receipt.
 *
 * It knows nothing about the shader. `effectsStatus` is handed in by the app,
 * which asks the surface what it actually ended up doing — the dialog just
 * prints the sentence.
 */
import { el, restoreFocus, setText } from './dom.ts'
import { icon } from './icons.ts'
import { Store } from './store.ts'
import type { EffectsSetting, Settings as SettingsState, State, WeekStart } from '../lib/types.ts'

export type SettingsHandlers = {
  announce: (message: string) => void
  /** One sentence about what the surface is doing right now. */
  effectsStatus: () => string
}

type Choice<T> = { value: T; label: string; hint: string }

const EFFECTS: Choice<EffectsSetting>[] = [
  { value: 'auto', label: 'Match my system', hint: 'Follows your reduced-motion setting' },
  { value: 'full', label: 'Full', hint: 'The surface flows and ripples' },
  { value: 'reduced', label: 'Reduced', hint: 'Still, but it still reports your backlog' },
  { value: 'off', label: 'Off', hint: 'A plain gradient, nothing running' },
]

const THEMES: Choice<SettingsState['theme']>[] = [
  { value: 'system', label: 'Match my system', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
  { value: 'light', label: 'Light', hint: '' },
]

const WEEK: Choice<WeekStart>[] = [
  { value: 1, label: 'Monday', hint: '' },
  { value: 0, label: 'Sunday', hint: '' },
]

export class Settings {
  readonly root: HTMLDialogElement

  private readonly store: Store
  private readonly handlers: SettingsHandlers
  private readonly effects = new Map<EffectsSetting, HTMLInputElement>()
  private readonly themes = new Map<SettingsState['theme'], HTMLInputElement>()
  private readonly weeks = new Map<WeekStart, HTMLInputElement>()
  private readonly status: HTMLElement
  private returnFocus: HTMLElement | null = null

  constructor(store: Store, handlers: SettingsHandlers) {
    this.store = store
    this.handlers = handlers
    this.status = el('p', { class: 'field-hint settings-status', role: 'status' })

    const close = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close' }, [
      icon('close'),
    ])
    close.addEventListener('click', () => this.close())

    const done = el('button', { class: 'text-button is-primary', type: 'button' }, ['Done'])
    done.addEventListener('click', () => this.close())

    this.root = el('dialog', { class: 'settings glass', 'aria-labelledby': 'settings-heading' }, [
      el('div', { class: 'detail-head' }, [
        el('h2', { class: 'manage-heading', id: 'settings-heading' }, ['Preferences']),
        close,
      ]),
      el('div', { class: 'detail-body' }, [
        this.group('Background effects', 'effects', EFFECTS, this.effects, (value) => {
          this.store.setSettings({ effects: value })
          this.handlers.announce(`Background effects: ${labelOf(EFFECTS, value)}`)
        }),
        this.status,
        this.group('Theme', 'theme', THEMES, this.themes, (value) => {
          this.store.setSettings({ theme: value })
          this.handlers.announce(`Theme: ${labelOf(THEMES, value)}`)
        }),
        this.group('Week starts on', 'week', WEEK, this.weeks, (value) => {
          this.store.setSettings({ weekStartsOn: value })
          this.handlers.announce(`Week starts on ${labelOf(WEEK, value)}`)
        }),
      ]),
      el('div', { class: 'detail-foot' }, [done]),
    ])

    this.root.addEventListener('close', () => this.teardown())
  }

  /**
   * One radio group.
   *
   * A `<fieldset>` with a `<legend>`, because that is the only markup that
   * names a set of radios to a screen reader without an aria-labelledby chain
   * that has to be kept in sync by hand.
   */
  private group<T extends string | number>(
    title: string,
    name: string,
    choices: Choice<T>[],
    into: Map<T, HTMLInputElement>,
    onPick: (value: T) => void,
  ): HTMLElement {
    const options = choices.map((choice) => {
      const id = `settings-${name}-${choice.value}`
      const input = el('input', { type: 'radio', name: `settings-${name}`, id, value: String(choice.value) })
      input.addEventListener('change', () => {
        if (input.checked) onPick(choice.value)
      })
      into.set(choice.value, input)

      return el('label', { class: 'choice', for: id }, [
        input,
        el('span', { class: 'choice-body' }, [
          el('span', { class: 'choice-label' }, [choice.label]),
          choice.hint ? el('span', { class: 'choice-hint' }, [choice.hint]) : null,
        ]),
      ])
    })

    return el('fieldset', { class: 'settings-group' }, [
      el('legend', { class: 'field-label' }, [title]),
      el('div', { class: 'choice-list' }, options),
    ])
  }

  open(): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.root.showModal()
    this.sync(this.store.getState())
    // The checked radio, not the first one: tabbing into a radio group lands on
    // the current answer, and opening the dialog should do the same.
    const current = this.effects.get(this.store.getState().settings.effects)
    restoreFocus(current ?? null, () => this.root.querySelector<HTMLElement>('input'))
  }

  close(): void {
    if (this.root.open) this.root.close()
    this.teardown()
  }

  get isOpen(): boolean {
    return this.root.open
  }

  /** Re-read the settings from the store. Called from the app's render pass. */
  sync(state: State): void {
    if (!this.root.open) return
    const { effects, theme, weekStartsOn } = state.settings
    for (const [value, input] of this.effects) input.checked = value === effects
    for (const [value, input] of this.themes) input.checked = value === theme
    for (const [value, input] of this.weeks) input.checked = value === weekStartsOn
    setText(this.status, this.handlers.effectsStatus())
  }

  private teardown(): void {
    const focus = this.returnFocus
    this.returnFocus = null
    restoreFocus(
      focus,
      () => document.querySelector<HTMLElement>('.header-settings'),
      () => document.querySelector<HTMLElement>('.view-title'),
    )
  }
}

function labelOf<T extends string | number>(choices: Choice<T>[], value: T): string {
  return choices.find((choice) => choice.value === value)?.label ?? String(value)
}
