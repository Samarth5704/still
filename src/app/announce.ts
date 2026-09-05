/**
 * The app's spoken channel.
 *
 * Two regions, because they have different urgencies: `polite` for completions
 * and undo, and a separate always-present summary of what the surface is
 * saying. The shader carries real information about the backlog, so a user who
 * cannot see it must be able to read the same thing — that is what
 * `summarise()` is for, and why it is a live region rather than a static label.
 *
 * Announcements are coalesced on a short timer. A burst of completions should
 * produce one sentence, not five interruptions.
 */
import { el } from './dom.ts'

export class Announcer {
  private readonly polite: HTMLElement
  private readonly summary: HTMLElement
  private pending: string[] = []
  private handle: number | null = null
  private lastSummary = ''

  constructor(parent: HTMLElement) {
    this.polite = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
    this.summary = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
    parent.append(this.polite, this.summary)
  }

  say(message: string): void {
    this.pending.push(message)
    if (this.handle !== null) clearTimeout(this.handle)
    this.handle = window.setTimeout(() => {
      this.handle = null
      this.polite.textContent = this.pending.join('. ')
      this.pending = []
    }, 150)
  }

  /**
   * The text equivalent of the surface: "Steady. 12 open tasks, 3 overdue."
   * Only spoken when it changes, so it does not re-announce on every render.
   */
  summarise(text: string): void {
    if (text === this.lastSummary) return
    this.lastSummary = text
    this.summary.textContent = text
  }
}
