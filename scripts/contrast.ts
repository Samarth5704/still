/**
 * The contrast gate.
 *
 * A moving background means contrast is a range rather than a number, so this
 * does not take a screenshot and measure it. It sweeps the whole space the
 * surface can occupy — a grid of pressure and heat, and at every point the
 * brightest and darkest pixel the shader can produce there (`gl/contrast.ts`) —
 * puts each of the stylesheet's scrims over it, and asks whether every ink the
 * app paints on that scrim still clears 4.5:1.
 *
 * Both ends matter, and they are opposite corners of the space: the dark
 * theme's worst case is a busy, late list throwing a bright crest under pale
 * text, and the light theme's is a calm, clear one sitting dark under dark text.
 * Checking the hot corner alone would pass a stylesheet that is unreadable when
 * your list is empty, which is the state this app is trying to get you to.
 *
 * The palette, the scrim and the inks are all READ rather than restated: the
 * ramp comes from `gl/palette.ts` (the same module the shader is uploaded from)
 * and every colour and alpha is parsed out of `src/style.css`. A token this
 * script does not know about is a failure, not a silent pass — see UNCHECKED.
 *
 * Run: npm run contrast
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DEFAULT_PALETTE } from '../src/gl/palette.ts'
import type { RGB } from '../src/gl/palette.ts'
import { AA_TEXT, composite, contrastRatio, saturate, surfaceExtremes } from '../src/gl/contrast.ts'

const CSS_PATH = resolve(process.cwd(), 'src/style.css')
const css = readFileSync(CSS_PATH, 'utf8')

/** How finely the space is sampled. 21 x 21 = 441 surfaces, each swept for extremes. */
const STEPS = 20

/** `backdrop-filter: blur(var(--blur)) saturate(1.4)` — the amount, read from the CSS. */
const SATURATION = readSaturation()

/**
 * Every ink the app sets as a `color`, and what it is for.
 *
 * `--warn` is the overdue mark: it is text and an icon, never a large heading,
 * so it is held to the body-text ratio like everything else. Nothing in this
 * app conveys meaning by colour alone, so no colour here is exempt on the
 * grounds of being decorative.
 */
const INKS = ['--ink', '--ink-dim', '--ink-faint', '--warn', '--warn-ink'] as const

/**
 * Custom properties that are deliberately not contrast-checked, with the reason.
 *
 * The point of naming them is the check below: any *other* token in the palette
 * block that is not in INKS fails the run. A new ink added without a decision
 * about its contrast is the exact failure this script exists to prevent, and
 * silence is how it would otherwise arrive.
 */
const UNCHECKED = new Map<string, string>([
  ['--warn-wash', 'a wash, checked over the scrim in WASHES below'],
  ['--field-bg', 'a wash, checked over the scrim in WASHES below'],
  ['--weekend-bg', 'a wash, checked over the scrim in WASHES below'],
  ['--today-ink', 'knocked out of a solid --ink disc; checked in PAIRS below'],
  ['--ground', 'the first-paint ground, behind the canvas and never under text'],
  ['--c-deep', 'palette stop; mirrored from gl/palette.ts and never painted under text'],
  ['--c-mid', 'palette stop'],
  ['--c-light', 'palette stop'],
  ['--c-foam', 'palette stop; used for focus rings and edges, checked as a non-text ratio below'],
  ['--c-teal', 'project/tag dot; paired with the name it belongs to, never text on its own'],
  ['--c-indigo', 'project/tag dot'],
  ['--c-amber', 'project/tag dot'],
  ['--c-plum', 'project/tag dot'],
  ['--c-moss', 'project/tag dot'],
  ['--c-clay', 'project/tag dot'],
  ['--scrim', 'the alpha this script composites with'],
  ['--glass-bg', 'the scrim itself'],
  ['--glass-edge', 'a one-pixel edge, not a text surface'],
  ['--glass-tint', 'the outer shadow, which falls outside the panel'],
  ['--glass-shadow', 'shadow geometry'],
  ['--glass-shadow-sm', 'shadow geometry'],
  ['--blur', 'filter length'],
  ['--radius', 'geometry'],
  ['--radius-sm', 'geometry'],
  ['--gap', 'geometry'],
  ['--tap', 'geometry'],
  ['--font', 'type'],
  ['--font-display', 'type'],
  ['--ease', 'motion'],
  ['--dur', 'motion'],
])

/**
 * Tints painted *over* the scrim, and the inks that sit on them.
 *
 * A wash is not a scrim — the read-only banner's warn tint is 0.16 and the
 * detail dialog's field is a 0.35 recess — so what has to hold is the ink
 * against the scrim AND the wash together. They are listed rather than
 * discovered because which ink lands on which wash is a fact about the markup,
 * not about the stylesheet.
 */
const WASHES: { token: string; where: string; inks: readonly string[] }[] = [
  { token: '--warn-wash', where: '.banner', inks: ['--warn-ink'] },
  { token: '--field-bg', where: 'form fields, hovered rows', inks: ['--ink', '--ink-dim', '--ink-faint'] },
  { token: '--weekend-bg', where: '.cal-cell.is-weekend', inks: ['--ink', '--ink-dim', '--ink-faint'] },
]

/**
 * Pairs that never see the surface at all: one opaque colour knocked out of
 * another. Today's numeral is the only one, and it is the mark that has to
 * survive greyscale, so it is worth holding to the same ratio.
 */
const PAIRS: { ink: string; on: string; where: string }[] = [
  { ink: '--today-ink', on: '--ink', where: '.cal-cell.is-today .cal-num' },
]

type Theme = {
  name: string
  /** The ink colours in force, by token name. */
  inks: Map<string, RGB>
  /** The tints painted over the scrim, by token name. */
  washes: Map<string, { colour: RGB; alpha: number }>
  /** Opaque colours used against each other rather than against the surface. */
  solids: Map<string, RGB>
  /** The scrim painted under text: colour and alpha. */
  scrim: { colour: RGB; alpha: number }
}

// ---- reading the stylesheet ------------------------------------------------

/** The body of the first `:root` rule matching `selector`, by brace matching. */
function block(selector: string): string {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`no ${selector} block in style.css`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`unterminated ${selector} block`)
}

/** `--name: value` declarations in a block, comments stripped. */
function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>()
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, name, value] of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name!, value!.trim())
  }
  return found
}

/** `rgb(6 16 30)` or `rgb(6 16 30 / 0.82)` — the only colour syntax the tokens use. */
function parseRGB(value: string): { colour: RGB; alpha: number } {
  const m = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([^)]+))?\)/.exec(value)
  if (!m) throw new Error(`not an rgb() token: ${value}`)
  const alphaText = (m[4] ?? '1').trim()
  const alpha = alphaText.startsWith('var(')
    ? Number.NaN // resolved by the caller against the token it names
    : Number(alphaText)
  return {
    colour: [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255],
    alpha,
  }
}

function readSaturation(): number {
  const m = /backdrop-filter:[^;]*saturate\(([\d.]+)\)/.exec(css)
  if (!m) throw new Error('no saturate() in any backdrop-filter; the glass has changed shape')
  return Number(m[1])
}

function themes(): Theme[] {
  const root = declarations(block(':root {'))
  // The light theme redefines a handful of tokens inside a
  // prefers-color-scheme block and inherits the rest.
  const light = new Map([...root, ...declarations(block(":root:not([data-theme='dark']) {"))])

  const build = (name: string, decls: Map<string, string>): Theme => {
    const scrimAlpha = Number(decls.get('--scrim'))
    if (!Number.isFinite(scrimAlpha)) throw new Error(`${name}: --scrim is not a number`)

    const glass = decls.get('--glass-bg')
    if (!glass) throw new Error(`${name}: no --glass-bg`)
    const parsed = parseRGB(glass)
    // The alpha is `var(--scrim)` by design — style.test.ts holds that shape —
    // so it is resolved here rather than duplicated in the token.
    const alpha = Number.isNaN(parsed.alpha) ? scrimAlpha : parsed.alpha

    const inks = new Map<string, RGB>()
    for (const token of INKS) {
      const value = decls.get(token)
      if (!value) throw new Error(`${name}: no ${token}`)
      inks.set(token, parseRGB(value).colour)
    }

    const washes = new Map<string, { colour: RGB; alpha: number }>()
    for (const { token } of WASHES) {
      const value = decls.get(token)
      if (!value) throw new Error(`${name}: no ${token}`)
      const wash = parseRGB(value)
      washes.set(token, { colour: wash.colour, alpha: Number.isNaN(wash.alpha) ? 1 : wash.alpha })
    }

    const solids = new Map<string, RGB>()
    for (const token of [...PAIRS.map((p) => p.ink), ...PAIRS.map((p) => p.on)]) {
      const value = decls.get(token)
      if (!value) throw new Error(`${name}: no ${token}`)
      // `--today-ink` is `var(--c-deep)` in the dark theme: one hop, resolved here.
      const hop = /var\((--[\w-]+)\)/.exec(value)
      const resolved = hop ? (decls.get(hop[1]!) ?? '') : value
      solids.set(token, parseRGB(resolved).colour)
    }

    return { name, inks, washes, solids, scrim: { colour: parsed.colour, alpha } }
  }

  return [build('dark', root), build('light', light)]
}

/** Every token in the palette block must be an ink we check or a documented exemption. */
function auditTokens(): string[] {
  const complaints: string[] = []
  for (const name of declarations(block(':root {')).keys()) {
    if ((INKS as readonly string[]).includes(name)) continue
    if (UNCHECKED.has(name)) continue
    complaints.push(
      `${name} is neither checked as an ink nor listed in UNCHECKED with a reason`,
    )
  }
  return complaints
}

// ---- the sweep -------------------------------------------------------------

type Worst = {
  ratio: number
  pressure: number
  heat: number
  /** Which end of the surface's range produced it. */
  end: 'crest' | 'trough'
}

function worstFor(theme: Theme, ink: RGB, wash?: { colour: RGB; alpha: number }): Worst {
  let worst: Worst = { ratio: Infinity, pressure: 0, heat: 0, end: 'crest' }

  for (let p = 0; p <= STEPS; p += 1) {
    for (let h = 0; h <= STEPS; h += 1) {
      const pressure = p / STEPS
      const heat = h / STEPS
      const { brightest, darkest } = surfaceExtremes(pressure, heat, DEFAULT_PALETTE)

      for (const [end, surface] of [
        ['crest', brightest],
        ['trough', darkest],
      ] as const) {
        const behind = saturate(surface, SATURATION)
        const scrimmed = composite(theme.scrim.colour, theme.scrim.alpha, behind)
        const under = wash ? composite(wash.colour, wash.alpha, scrimmed) : scrimmed
        const ratio = contrastRatio(ink, under)
        if (ratio < worst.ratio) worst = { ratio, pressure, heat, end }
      }
    }
  }

  return worst
}

// ---- report ----------------------------------------------------------------

const pad = (s: string, n: number): string => s.padEnd(n)
const ratio = (n: number): string => `${n.toFixed(2)}:1`

function main(): void {
  const complaints = auditTokens()
  const rows: { theme: string; what: string; ink: string; worst: Worst }[] = []

  for (const theme of themes()) {
    // Every ink on the bare scrim: the case that covers most of the app.
    for (const [name, ink] of theme.inks) {
      rows.push({ theme: theme.name, what: 'scrim', ink: name, worst: worstFor(theme, ink) })
    }

    // The three tints painted over it, each with the inks that land on it.
    for (const { token, where, inks } of WASHES) {
      const wash = theme.washes.get(token)!
      for (const name of inks) {
        rows.push({
          theme: theme.name,
          what: where,
          ink: name,
          worst: worstFor(theme, theme.inks.get(name)!, wash),
        })
      }
    }

    // And the one pair that never meets the surface at all.
    for (const { ink, on, where } of PAIRS) {
      const value = contrastRatio(theme.solids.get(ink)!, theme.solids.get(on)!)
      rows.push({
        theme: theme.name,
        what: where,
        ink,
        worst: { ratio: value, pressure: Number.NaN, heat: Number.NaN, end: 'crest' },
      })
    }
  }

  const grid = (STEPS + 1) * (STEPS + 1)
  const [dark] = themes()
  console.log("Contrast across the surface's whole range")
  console.log(`  ${grid} points of pressure x heat, both extremes of the shader at each,`)
  console.log(`  under the scrim (alpha ${dark!.scrim.alpha}, saturate ${SATURATION}).`)
  console.log('')
  console.log(
    `  ${pad('theme', 7)}${pad('on', 28)}${pad('ink', 13)}${pad('worst', 9)}${pad('at', 22)}`,
  )
  console.log(`  ${'-'.repeat(82)}`)

  let failed = 0
  for (const { theme, what, ink, worst } of rows) {
    const ok = worst.ratio >= AA_TEXT
    if (!ok) failed += 1
    const at = Number.isNaN(worst.pressure)
      ? 'opaque, no surface'
      : `p ${worst.pressure.toFixed(2)} h ${worst.heat.toFixed(2)} ${worst.end}`
    console.log(
      `  ${pad(theme, 7)}${pad(what, 28)}${pad(ink, 13)}${pad(ratio(worst.ratio), 9)}${pad(at, 22)}${ok ? 'ok' : 'FAIL'}`,
    )
  }

  console.log('')
  for (const complaint of complaints) console.log(`  token: ${complaint}`)

  if (failed > 0 || complaints.length > 0) {
    console.log('')
    console.log(
      `${failed} of ${rows.length} checks fall below ${AA_TEXT}:1 somewhere in the range` +
        (complaints.length > 0 ? `, and ${complaints.length} token(s) are unclassified` : ''),
    )
    process.exit(1)
  }

  console.log(`  all ${rows.length} checks hold ${AA_TEXT}:1 everywhere in the range.`)
}

main()
