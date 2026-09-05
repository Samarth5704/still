/**
 * Icons, hand-written.
 *
 * No icon font, no sprite sheet, no dependency. Each is a 24x24 stroke path on
 * a shared grid, inheriting `currentColor` and the surrounding font size, so an
 * icon beside text always matches it.
 *
 * Every icon here is decorative: it sits next to a real text label or inside a
 * button that carries its own accessible name, so they are all
 * `aria-hidden`. An icon that ever becomes the only label needs a title, and
 * that would be a bug in the caller, not here.
 */
import { svg } from './dom.ts'

type IconName =
  | 'check'
  | 'sun'
  | 'horizon'
  | 'layers'
  | 'calendar'
  | 'circle'
  | 'tag'
  | 'plus'
  | 'undo'
  | 'chevron-up'
  | 'chevron-down'
  | 'repeat'
  | 'clock'
  | 'alert'

const PATHS: Record<IconName, string[]> = {
  check: ['M4 12.5 9 17.5 20 6.5'],
  sun: ['M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z', 'M12 1.5v2M12 20.5v2M1.5 12h2M20.5 12h2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M19.4 4.6 18 6M6 18l-1.4 1.4'],
  horizon: ['M2 16h20', 'M6 16a6 6 0 0 1 12 0', 'M12 3v3M4.5 6.5 6 8M19.5 6.5 18 8'],
  layers: ['M12 3 3 8l9 5 9-5-9-5Z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  calendar: ['M4 6.5h16v14H4z', 'M4 10.5h16', 'M8 3.5v4M16 3.5v4'],
  circle: ['M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z'],
  tag: ['M11 3H3v8l10 10 8-8L11 3Z', 'M7 7h.01'],
  plus: ['M12 5v14M5 12h14'],
  undo: ['M4 9h11a5 5 0 0 1 0 10h-4', 'M8 5 4 9l4 4'],
  'chevron-up': ['M6 14.5 12 8.5l6 6'],
  'chevron-down': ['M6 9.5 12 15.5l6-6'],
  repeat: ['M4 10a6 6 0 0 1 6-6h10', 'M17 1l3 3-3 3', 'M20 14a6 6 0 0 1-6 6H4', 'M7 23l-3-3 3-3'],
  clock: ['M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z', 'M12 8v4.5l3 2'],
  alert: ['M12 4 2.5 20.5h19L12 4Z', 'M12 10v4.5', 'M12 17.5h.01'],
}

export function icon(name: IconName, className = 'icon'): SVGElement {
  return svg(
    'svg',
    {
      class: className,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.75,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    PATHS[name].map((d) => svg('path', { d })),
  )
}

/** The wordmark. Set in the display face, not drawn, so it stays selectable text. */
export function wordmark(): HTMLElement {
  const span = document.createElement('span')
  span.className = 'wordmark'
  span.textContent = 'still'
  return span
}
