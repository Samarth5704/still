/**
 * The undo affordance.
 *
 * A completion is destructive enough to need taking back and common enough that
 * a confirmation dialog would be insufferable, so it is optimistic with an
 * eight-second window instead.
 *
 * The button must be reachable by keyboard before it expires. That rules out
 * the usual toast-in-a-corner pattern that nothing can tab to: this one is a
 * real `<button>` in the document, it announces itself politely, and `Ctrl+Z`
 * fires the same action for anyone who would rather not go looking for it.
 */
import { el, setText } from './dom.ts'
import { icon } from './icons.ts'
import { UNDO_WINDOW_MS } from './store.ts'

export class UndoBar {
  readonly root: HTMLElement
  private readonly message: HTMLElement
  private readonly button: HTMLButtonElement
  private handle: number | null = null
  private action: (() => void) | null = null

  constructor() {
    this.message = el('span', { class: 'undo-message' })
    this.button = el('button', { class: 'undo-button', type: 'button' }, [icon('undo'), 'Undo'])
    this.button.addEventListener('click', () => this.fire())

    this.root = el('div', { class: 'undo-bar glass', role: 'status', 'aria-live': 'polite' }, [
      this.message,
      this.button,
    ])
    this.root.hidden = true
  }

  show(message: string, action: () => void, onExpire: () => void): void {
    this.clearTimer()
    this.action = action
    setText(this.message, message)
    this.root.hidden = false
    this.root.classList.add('is-visible')
    // Name the button after what it undoes; three stacked "Undo"s in a row's
    // history are indistinguishable otherwise.
    this.button.setAttribute('aria-label', `Undo: ${message}`)

    this.handle = window.setTimeout(() => {
      this.handle = null
      this.hide()
      onExpire()
    }, UNDO_WINDOW_MS)
  }

  /** True while there is something to undo, so a keyboard shortcut can defer to it. */
  get isActive(): boolean {
    return this.action !== null
  }

  fire(): void {
    const action = this.action
    if (!action) return
    // Focus would otherwise land nowhere when the bar disappears under it.
    const returnFocus = document.activeElement === this.button
    this.hide()
    action()
    if (returnFocus) document.querySelector<HTMLElement>('.quick-add-input')?.focus()
  }

  hide(): void {
    this.clearTimer()
    this.action = null
    this.root.classList.remove('is-visible')
    this.root.hidden = true
  }

  private clearTimer(): void {
    if (this.handle !== null) clearTimeout(this.handle)
    this.handle = null
  }
}
