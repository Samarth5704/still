/**
 * The two performance rules that are structural, held structurally.
 *
 * The numbers in `docs/performance.md` were measured in a browser and they go
 * stale the moment someone writes a `getBoundingClientRect()` into the render
 * loop. These two claims are not about a machine, though — they are about the
 * shape of the code, and the shape can be checked here, on every commit,
 * without a GPU:
 *
 *   - the render loop touches no DOM and reads no layout
 *   - the list reconciles keyed nodes and never rebuilds itself from a string
 *
 * Both failures are silent and both look fine until the list is long. A single
 * `offsetHeight` inside `frame()` forces a synchronous layout sixty times a
 * second against however many task rows are on screen; `innerHTML =` throws
 * away focus, selection, scroll position and every in-flight animation, which
 * on a short list is invisible and on a real one is the whole experience.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/**
 * Properties and methods that force the browser to compute layout before they
 * can answer. Reading any of them mid-frame is the definition of layout thrash.
 */
const LAYOUT_READS = [
  'getBoundingClientRect',
  'getClientRects',
  'offsetWidth',
  'offsetHeight',
  'offsetTop',
  'offsetLeft',
  'clientWidth',
  'clientHeight',
  'scrollWidth',
  'scrollHeight',
  'getComputedStyle',
  'scrollTop',
]

describe('the render loop', () => {
  const renderer = read('./gl/renderer.ts')

  /** The body of a method or arrow property, by brace matching from its name. */
  function body(source: string, declaration: string): string {
    const start = source.indexOf(declaration)
    expect(start, `no ${declaration} in renderer.ts`).toBeGreaterThan(-1)
    const open = source.indexOf('{', start + declaration.length)
    let depth = 0
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(open + 1, i)
      }
    }
    throw new Error(`unterminated ${declaration}`)
  }

  const loop = [
    body(renderer, 'private readonly frame = '),
    body(renderer, 'private draw()'),
    body(renderer, 'private throttled('),
    body(renderer, 'private governResolution()'),
  ].join('\n')

  it.each(LAYOUT_READS)('never reads %s', (api) => {
    expect(loop, `${api} in the render loop forces a synchronous layout every frame`).not.toContain(
      api,
    )
  })

  it('takes its size from the ResizeObserver rather than measuring the canvas', () => {
    // The size is pushed in from outside precisely so the loop never has to ask.
    expect(renderer).toContain('new ResizeObserver')
    expect(body(renderer, 'private draw()')).toContain('this.canvas.width = this.width')
  })

  it('measures the canvas only where a pointer event already forced layout', () => {
    // `rippleAtClient` translates a click position, so it is on the event path,
    // not the frame path — and it is the only place allowed to measure.
    const uses = [...renderer.matchAll(/getBoundingClientRect/g)]
    expect(uses).toHaveLength(1)
    expect(body(renderer, 'rippleAtClient(')).toContain('getBoundingClientRect')
  })
})

describe('the list', () => {
  const modules = [
    'app/tasklist.ts',
    'app/calendar.ts',
    'app/detail.ts',
    'app/manage.ts',
    'app/chrome.ts',
    'app/settings.ts',
    'app/empty.ts',
    'app/quickadd.ts',
    'app/recurrence.ts',
    'app/undo.ts',
    'app/dom.ts',
  ]

  it.each(modules)('%s never assigns innerHTML or outerHTML', (path) => {
    const source = read(`./${path}`)
    expect(source, 'rebuilding from a string throws away focus and scroll').not.toMatch(
      /\b(innerHTML|outerHTML)\s*=/,
    )
    expect(source).not.toContain('insertAdjacentHTML')
  })

  it('reconciles keyed nodes and skips rows nothing has changed on', () => {
    const tasklist = read('./app/tasklist.ts')
    // The row cache is the key; the signature is what stops an unchanged row
    // from doing DOM work at all.
    expect(tasklist).toContain('private readonly rows = new Map<string, Row>()')
    expect(tasklist).toMatch(/if \(row\.signature === signature\) return/)
    expect(tasklist).toContain('reconcile(')
  })
})
