/**
 * Header and navigation.
 *
 * The header carries the pressure readout, which is the surface stated in
 * words. The shader is the ambient version of this number; these words are the
 * version you can read, quote, and hear. Neither is the fallback for the other.
 */
import { el, setAttr, setClass, setText } from './dom.ts'
import { icon, wordmark } from './icons.ts'
import { pressureLabel } from '../lib/pressure.ts'
import { formatHash, sameView } from '../lib/views.ts'
import type { View, ViewCounts } from '../lib/views.ts'
import type { PressureSummary, State } from '../lib/types.ts'

export class Header {
  readonly root: HTMLElement
  private readonly label: HTMLElement
  private readonly detail: HTMLElement

  constructor(onManage: () => void, onSettings: () => void) {
    this.label = el('span', { class: 'pressure-label' })
    this.detail = el('span', { class: 'pressure-detail' })

    // The one way into the catalogues, and it lives here rather than in the
    // sidebar because the sidebar becomes a four-target bottom bar on mobile:
    // a control tucked into the projects heading would simply not exist below
    // 720px.
    const manage = el(
      'button',
      { class: 'icon-button header-manage', type: 'button', 'aria-label': 'Manage projects and tags' },
      [icon('settings')],
    )
    manage.addEventListener('click', onManage)

    // Preferences sit beside it for the same reason. The effects control in
    // particular has to be reachable on the device most likely to want it
    // turned down.
    const settings = el(
      'button',
      { class: 'icon-button header-settings', type: 'button', 'aria-label': 'Preferences' },
      [icon('sliders')],
    )
    settings.addEventListener('click', onSettings)

    this.root = el('header', { class: 'app-header glass' }, [
      // Named for what the link does, not just what it says: "still" alone is
      // an odd thing to hear announced as a destination.
      el('a', { class: 'brand', href: '#/today', 'aria-label': 'Still — go to Today' }, [wordmark()]),
      el('div', { class: 'header-end' }, [
        el('div', { class: 'pressure' }, [this.label, this.detail]),
        manage,
        settings,
      ]),
    ])
  }

  render(pressure: PressureSummary): void {
    const word = pressureLabel(pressure.pressure)
    setText(this.label, word)
    setAttr(this.root, 'data-pressure', word.toLowerCase())

    // The overdue count is stated separately rather than folded into the word,
    // because "Busy" and "Busy, 3 overdue" are different situations.
    const open = `${pressure.openCount} open`
    setText(this.detail, pressure.overdueCount > 0 ? `${open} · ${pressure.overdueCount} overdue` : open)
    setClass(this.detail, 'has-overdue', pressure.overdueCount > 0)
  }

  /** The same sentence, for the live region. */
  static summary(pressure: PressureSummary): string {
    const word = pressureLabel(pressure.pressure)
    const tasks = `${pressure.openCount} open ${pressure.openCount === 1 ? 'task' : 'tasks'}`
    return pressure.overdueCount > 0
      ? `${word}. ${tasks}, ${pressure.overdueCount} overdue.`
      : `${word}. ${tasks}.`
  }
}

type NavItem = {
  view: View
  title: string
  icon: Parameters<typeof icon>[0]
  count: (counts: ViewCounts) => number
  /** Overdue in Today is worth flagging in the nav itself. */
  alert?: (counts: ViewCounts) => boolean
}

const BUILT_IN: NavItem[] = [
  { view: { kind: 'today' }, title: 'Today', icon: 'sun', count: (c) => c.today, alert: (c) => c.overdue > 0 },
  { view: { kind: 'upcoming' }, title: 'Upcoming', icon: 'horizon', count: (c) => c.upcoming },
  { view: { kind: 'all' }, title: 'All', icon: 'layers', count: (c) => c.all },
  { view: { kind: 'calendar', day: null }, title: 'Calendar', icon: 'calendar', count: () => 0 },
]

export class Nav {
  readonly root: HTMLElement
  private readonly primary: HTMLElement
  private readonly projects: HTMLElement
  private readonly projectHeading: HTMLElement
  private readonly tags: HTMLElement
  private readonly tagHeading: HTMLElement
  private readonly links = new Map<string, { a: HTMLAnchorElement; count: HTMLElement }>()

  constructor() {
    this.primary = el('ul', { class: 'nav-list' })
    this.projects = el('ul', { class: 'nav-list nav-projects' })
    this.tags = el('ul', { class: 'nav-list nav-tags' })

    this.projectHeading = el('h2', { class: 'nav-heading' }, ['Projects'])
    this.tagHeading = el('h2', { class: 'nav-heading' }, ['Tags'])

    this.root = el('nav', { class: 'app-nav glass', 'aria-label': 'Views' }, [
      this.primary,
      this.projectHeading,
      this.projects,
      this.tagHeading,
      this.tags,
    ])
  }

  render(state: State, counts: ViewCounts, current: View): void {
    this.renderInto(this.primary, BUILT_IN, counts, current)

    // Archived entries drop out of the sidebar and stay resolvable everywhere
    // else. That is the whole bargain archiving offers.
    const projectItems: NavItem[] = state.projects
      .filter((p) => !p.archived)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        view: { kind: 'project', id: p.id } as View,
        title: p.name,
        icon: 'circle' as const,
        count: (c: ViewCounts) => c.byProject.get(p.id) ?? 0,
      }))

    this.projectHeading.hidden = projectItems.length === 0
    this.renderInto(this.projects, projectItems, counts, current, state)

    const tagItems: NavItem[] = state.tags
      .filter((t) => !t.archived)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        view: { kind: 'tag', id: t.id } as View,
        title: `@${t.name}`,
        icon: 'tag' as const,
        count: (c: ViewCounts) => c.byTag.get(t.id) ?? 0,
      }))

    this.tagHeading.hidden = tagItems.length === 0
    this.renderInto(this.tags, tagItems, counts, current, state)
  }

  private renderInto(
    parent: HTMLElement,
    items: NavItem[],
    counts: ViewCounts,
    current: View,
    state?: State,
  ): void {
    const desired: Element[] = []

    for (const item of items) {
      const href = formatHash(item.view)
      let entry = this.links.get(href)
      if (!entry) {
        const count = el('span', { class: 'nav-count' })
        const a = el('a', { class: 'nav-link', href }, [
          icon(item.icon, 'icon nav-icon'),
          el('span', { class: 'nav-title' }, [item.title]),
          count,
        ])
        entry = { a, count }
        this.links.set(href, entry)
      }

      const itemView = item.view
      const colour = !state
        ? undefined
        : itemView.kind === 'project'
          ? state.projects.find((p) => p.id === itemView.id)?.colorToken
          : itemView.kind === 'tag'
            ? state.tags.find((t) => t.id === itemView.id)?.colorToken
            : undefined
      if (colour) entry.a.style.setProperty('--nav-dot', `var(--c-${colour})`)

      setText(entry.a.querySelector('.nav-title')!, item.title)

      const n = item.count(counts)
      setText(entry.count, n > 0 ? String(n) : '')
      entry.count.hidden = n === 0
      setClass(entry.a, 'has-alert', item.alert?.(counts) ?? false)

      const active = sameView(item.view, current)
      setAttr(entry.a, 'aria-current', active && 'page')

      // The count is part of the link's name, so it is heard rather than
      // silently skipped as decorative text.
      const suffix = n > 0 ? `, ${n}` : ''
      const alert = item.alert?.(counts) ? `, ${counts.overdue} overdue` : ''
      setAttr(entry.a, 'aria-label', `${item.title}${suffix}${alert}`)

      desired.push(el('li', {}, [entry.a]))
    }

    // Wrapper `<li>`s are cheap and change identity each pass; the anchors
    // inside them are the nodes that persist and hold focus.
    const existing = [...parent.children]
    if (existing.length === desired.length) {
      existing.forEach((node, i) => {
        const wanted = desired[i]!.firstElementChild!
        if (node.firstElementChild !== wanted) node.replaceChildren(wanted)
      })
    } else {
      parent.replaceChildren(...desired)
    }
  }
}
