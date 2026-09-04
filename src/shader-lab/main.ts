/**
 * The surface lab — a slider board for the shader, with no app in the way.
 *
 * Phase 2 exists before the app deliberately: tuning a fragment shader through
 * a task list is miserable. This page ships but is never linked from the app.
 */
import './lab.css'
import { DEFAULT_PALETTE, type Palette, type Ramp, fromHex, toHex } from '../gl/palette.ts'
import { Surface } from '../gl/renderer.ts'
import { paintFallback } from '../gl/fallback.ts'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const canvas = el<HTMLCanvasElement>('surface')
const fallback = el<HTMLDivElement>('fallback')
const status = el<HTMLParagraphElement>('status')

const pressureInput = el<HTMLInputElement>('pressure')
const heatInput = el<HTMLInputElement>('heat')
const stillInput = el<HTMLInputElement>('still')
const timeScaleInput = el<HTMLInputElement>('timescale')
const strengthInput = el<HTMLInputElement>('ripple-strength')

const GROUPS = ['cool', 'dusk', 'warm'] as const
const STOPS = ['deep', 'mid', 'light', 'foam'] as const

type Group = (typeof GROUPS)[number]

const paletteInputs: Record<Group, Record<keyof Ramp, HTMLInputElement>> = {
  cool: {
    deep: el<HTMLInputElement>('cool-deep'),
    mid: el<HTMLInputElement>('cool-mid'),
    light: el<HTMLInputElement>('cool-light'),
    foam: el<HTMLInputElement>('cool-foam'),
  },
  dusk: {
    deep: el<HTMLInputElement>('dusk-deep'),
    mid: el<HTMLInputElement>('dusk-mid'),
    light: el<HTMLInputElement>('dusk-light'),
    foam: el<HTMLInputElement>('dusk-foam'),
  },
  warm: {
    deep: el<HTMLInputElement>('warm-deep'),
    mid: el<HTMLInputElement>('warm-mid'),
    light: el<HTMLInputElement>('warm-light'),
    foam: el<HTMLInputElement>('warm-foam'),
  },
}

const surface = Surface.create(canvas)

// Where "at cursor" means, before the pointer has ever moved.
let cursor = { x: globalThis.innerWidth / 2, y: globalThis.innerHeight / 2 }
let showFallback = surface === null
let running = true

function readNumber(input: HTMLInputElement): number {
  const n = Number.parseFloat(input.value)
  return Number.isFinite(n) ? n : 0
}

function bindOutput(input: HTMLInputElement, output: HTMLOutputElement): void {
  const sync = (): void => {
    output.textContent = readNumber(input).toFixed(2)
  }
  input.addEventListener('input', sync)
  sync()
}

function currentPalette(): Palette {
  const read = (group: Group): Ramp => ({
    deep: fromHex(paletteInputs[group].deep.value),
    mid: fromHex(paletteInputs[group].mid.value),
    light: fromHex(paletteInputs[group].light.value),
    foam: fromHex(paletteInputs[group].foam.value),
  })
  return { cool: read('cool'), dusk: read('dusk'), warm: read('warm') }
}

function applyInputs(): void {
  const pressure = readNumber(pressureInput)
  const heat = readNumber(heatInput)
  const palette = currentPalette()

  surface?.setTargets(pressure, heat)
  surface?.setStill(readNumber(stillInput))
  surface?.setPalette(palette)
  if (surface) surface.timeScale = readNumber(timeScaleInput)

  if (showFallback) paintFallback(fallback, pressure, heat, palette)
}

function resetPalette(): void {
  for (const group of GROUPS) {
    for (const stop of STOPS) {
      paletteInputs[group][stop].value = toHex(DEFAULT_PALETTE[group][stop])
    }
  }
  applyInputs()
}

// -------------------------------------------------------------- wiring ----

bindOutput(pressureInput, el<HTMLOutputElement>('pressure-out'))
bindOutput(heatInput, el<HTMLOutputElement>('heat-out'))
bindOutput(stillInput, el<HTMLOutputElement>('still-out'))
bindOutput(timeScaleInput, el<HTMLOutputElement>('timescale-out'))
bindOutput(strengthInput, el<HTMLOutputElement>('ripple-strength-out'))

el<HTMLFormElement>('panel').addEventListener('input', applyInputs)
el<HTMLFormElement>('panel').addEventListener('submit', (e) => e.preventDefault())
el<HTMLButtonElement>('reset-palette').addEventListener('click', resetPalette)

globalThis.addEventListener('pointermove', (e) => {
  cursor = { x: e.clientX, y: e.clientY }
})

canvas.addEventListener('pointerdown', (e) => {
  surface?.rippleAtClient(e.clientX, e.clientY, readNumber(strengthInput))
})

el<HTMLButtonElement>('ripple').addEventListener('click', () => {
  surface?.rippleAtClient(cursor.x, cursor.y, readNumber(strengthInput))
})

// Nine ripples do not fit in eight slots. Firing ten proves what happens.
el<HTMLButtonElement>('burst').addEventListener('click', () => {
  for (let i = 0; i < 10; i += 1) {
    const angle = (i / 10) * Math.PI * 2
    surface?.ripple(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5, readNumber(strengthInput))
  }
})

const runButton = el<HTMLButtonElement>('toggle-run')
runButton.addEventListener('click', () => {
  running = !running
  if (running) surface?.start()
  else surface?.stop()
  runButton.textContent = running ? 'Pause' : 'Resume'
})

const fallbackButton = el<HTMLButtonElement>('toggle-fallback')
fallbackButton.addEventListener('click', () => {
  showFallback = !showFallback
  fallback.hidden = !showFallback
  canvas.hidden = showFallback
  fallbackButton.textContent = showFallback ? 'Show shader' : 'Show CSS fallback'
  if (showFallback) surface?.stop()
  else if (running) surface?.start()
  applyInputs()
})

// A real driver reset is hard to arrange on demand, so borrow the extension
// that simulates one. If recovery works here it works there.
el<HTMLButtonElement>('lose-context').addEventListener('click', () => {
  const gl = canvas.getContext('webgl2')
  const ext = gl?.getExtension('WEBGL_lose_context')
  if (!ext) return
  ext.loseContext()
  globalThis.setTimeout(() => ext.restoreContext(), 1200)
})

// ------------------------------------------------------------- readouts ----

const statFps = el<HTMLElement>('stat-fps')
const statFrame = el<HTMLElement>('stat-frame')
const statGpu = el<HTMLElement>('stat-gpu')
const statSize = el<HTMLElement>('stat-size')

function refreshStats(): void {
  if (!surface) return
  const s = surface.stats
  statFps.textContent = s.fps > 0 ? s.fps.toFixed(0) : '—'
  statFrame.textContent = s.frameMs > 0 ? `${s.frameMs.toFixed(1)} ms` : '—'
  statGpu.textContent = s.gpuMs === null ? 'n/a' : `${s.gpuMs.toFixed(2)} ms`
  statSize.textContent = `${canvas.width}x${canvas.height}`
  status.textContent = showFallback
    ? 'static fallback — shader stopped'
    : s.contextLost
      ? 'context lost — waiting for restore'
      : !running
        ? 'paused'
        : s.idle
          ? `idle throttle (${Math.round(s.fps)}fps)`
          : 'running'
}

if (surface) {
  resetPalette()
  surface.snapToTargets()
  surface.start()
  // Stats are read on a timer, not in the render loop: the loop must not touch
  // the DOM.
  globalThis.setInterval(refreshStats, 250)
} else {
  fallback.hidden = false
  canvas.hidden = true
  fallbackButton.disabled = true
  runButton.disabled = true
  el<HTMLButtonElement>('lose-context').disabled = true
  status.textContent = 'no WebGL2 — static fallback'
  resetPalette()
}
