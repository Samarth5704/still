/**
 * The question dialog.
 *
 * Three places in this app destroy something that other things point at:
 * deleting a task with subtasks, deleting a project, and deleting a tag. In all
 * three the honest interface is the same — say what is about to happen, state
 * the counts, and offer the alternatives as named buttons rather than a
 * yes/no that hides the second option.
 *
 * So this is a *choice* dialog, not a confirm dialog. There is no "OK": every
 * button says what it does, and Cancel is the only way to leave without a
 * decision. A modal `<dialog>` gives focus trapping and Escape for free; the
 * one thing it does not give reliably once the node is removed is focus
 * restoration, so that is done by hand.
 */
import { el, restoreFocus } from './dom.ts'

export type Choice<T extends string> = {
  value: T
  label: string
  /** The consequence, stated in full: "12 tasks move to Admin". */
  detail?: string
  tone?: 'danger'
  /** The button focused when the dialog opens. Make it the safe one. */
  preferred?: boolean
}

export type AskOptions<T extends string> = {
  title: string
  message?: string
  choices: Choice<T>[]
  cancelLabel?: string
  /**
   * Where focus goes when the control that opened this question no longer
   * exists — which is the normal case here, since the answer usually deletes
   * the very row whose delete button was pressed. Named by the caller because
   * only the caller knows what is still standing, and because a fallback has
   * to be inside the dialog underneath if that dialog is still modal.
   */
  focusFallbacks?: (() => HTMLElement | null)[]
}

/**
 * Ask, and resolve with the chosen value — or `null` if the user cancelled,
 * pressed Escape, or dismissed the dialog any other way. Cancelling is always a
 * distinct answer from choosing, never a silent default.
 */
export function ask<T extends string>(options: AskOptions<T>): Promise<T | null> {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const heading = el('h2', { class: 'ask-title', id: 'ask-title' }, [options.title])
  const body: HTMLElement[] = [heading]
  if (options.message) body.push(el('p', { class: 'ask-message' }, [options.message]))

  const dialog = el('dialog', { class: 'ask glass', 'aria-labelledby': 'ask-title' })
  let answer: T | null = null

  /**
   * Teardown, run exactly once.
   *
   * The buttons call this directly rather than closing and waiting for the
   * `close` event to finish the job. The event is still listened for — Escape
   * and the backdrop only reach us that way — but making the common path
   * depend on it would put the whole promise behind one event firing, and a
   * question that never resolves is a locked-up app.
   */
  let settle: ((value: T | null) => void) | null = null
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    if (dialog.open) dialog.close()
    dialog.remove()
    // Without this, focus lands on <body> and a keyboard user starts again
    // from the top of the page — and the trigger is usually gone, because the
    // answer just deleted the row it sat in.
    restoreFocus(returnFocus, ...(options.focusFallbacks ?? []))
    settle?.(answer)
  }

  const buttons = options.choices.map((choice) => {
    const button = el(
      'button',
      { class: 'ask-choice', type: 'button', 'data-tone': choice.tone ?? 'neutral' },
      [
        el('span', { class: 'ask-choice-label' }, [choice.label]),
        choice.detail ? el('span', { class: 'ask-choice-detail' }, [choice.detail]) : null,
      ],
    )
    button.addEventListener('click', () => {
      answer = choice.value
      finish()
    })
    return button
  })

  const cancel = el('button', { class: 'ask-cancel', type: 'button' }, [
    options.cancelLabel ?? 'Cancel',
  ])
  cancel.addEventListener('click', () => finish())

  dialog.append(
    el('div', { class: 'ask-body' }, body),
    el('div', { class: 'ask-choices' }, buttons),
    el('div', { class: 'ask-footer' }, [cancel]),
  )

  document.body.append(dialog)

  return new Promise<T | null>((resolve) => {
    settle = resolve
    // Escape and a backdrop click reach us only as `close`; the answer is still
    // null, so cancelling stays a distinct outcome from choosing.
    dialog.addEventListener('close', finish)
    dialog.showModal()

    const preferred = options.choices.findIndex((c) => c.preferred)
    const focusTarget = preferred >= 0 ? buttons[preferred] : cancel
    focusTarget?.focus()
  })
}

/** "3 tasks" / "1 task", because "1 tasks" in a confirmation reads as a bug. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
