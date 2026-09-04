/**
 * The WebGL2 renderer for the surface.
 *
 * Everything that makes a full-screen fragment shader survivable in a real
 * product lives here: context-loss recovery, a device-pixel-ratio cap, a loop
 * that stops when the tab is hidden, and an idle throttle. None of it is
 * optional — a shader that dies on a GPU driver reset, or that cooks a phone
 * at 3x DPR, is not a background, it is a liability.
 *
 * The loop touches no DOM and reads no layout: sizing comes from a
 * ResizeObserver, not from measuring the canvas each frame.
 */
import fragSource from './surface.frag.glsl?raw'
import vertSource from './quad.vert.glsl?raw'
import { DEFAULT_PALETTE, type Palette, rampFloats } from './palette.ts'
import { RIPPLE_SLOTS, RippleBuffer } from './ripples.ts'
import { SETTLED_EPSILON, SETTLE_TAU, approach } from './smoothing.ts'

/** A 3x DPR phone rendering this at native resolution will thermally throttle. */
export const MAX_DPR = 1.5

/** No interaction and a settled surface for this long drops the frame rate. */
export const IDLE_AFTER_MS = 10_000
export const IDLE_FPS = 24

/** Largest step the clock will take, so a long stall does not teleport the surface. */
const MAX_STEP_SECONDS = 0.05

export type SurfaceStats = {
  /** Smoothed presented frames per second. */
  fps: number
  /** Smoothed wall time between frames, ms. */
  frameMs: number
  /** GPU time for the draw in ms, when EXT_disjoint_timer_query_webgl2 exists. */
  gpuMs: number | null
  /** True while the context is lost and the loop is parked. */
  contextLost: boolean
  /** True while the idle throttle is holding the rate down. */
  idle: boolean
}

type Uniforms = {
  uTime: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  uPressure: WebGLUniformLocation | null
  uHeat: WebGLUniformLocation | null
  uRipples: WebGLUniformLocation | null
  uStill: WebGLUniformLocation | null
  uCool: WebGLUniformLocation | null
  uDusk: WebGLUniformLocation | null
  uWarm: WebGLUniformLocation | null
}

export class Surface {
  /** Returns null when WebGL2 is unavailable — the caller shows the CSS fallback. */
  static create(canvas: HTMLCanvasElement): Surface | null {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    })
    if (!gl) return null
    return new Surface(canvas, gl)
  }

  readonly stats: SurfaceStats = {
    fps: 0,
    frameMs: 0,
    gpuMs: null,
    contextLost: false,
    idle: false,
  }

  /** Multiplies the clock. 1 is real time; the lab uses it to slow the surface down. */
  timeScale = 1

  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null
  private uniforms: Uniforms | null = null

  private readonly ripples = new RippleBuffer()
  private readonly rippleData = new Float32Array(RIPPLE_SLOTS * 4)
  private readonly coolData = rampFloats(DEFAULT_PALETTE.cool)
  private readonly duskData = rampFloats(DEFAULT_PALETTE.dusk)
  private readonly warmData = rampFloats(DEFAULT_PALETTE.warm)

  private targetPressure = 0
  private targetHeat = 0
  private pressure = 0
  private heat = 0
  private still = 0

  private time = 0
  private lastFrameAt: number | null = null
  private lastDrawAt = 0
  private lastActivityAt = 0
  private frameHandle = 0
  private running = false

  private width = 0
  private height = 0
  private dirtySize = true

  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null
  private pendingQuery: WebGLQuery | null = null

  private readonly observer: ResizeObserver
  private readonly onLost = (event: Event): void => {
    // Without preventDefault the context is never restored and the surface is
    // gone for the lifetime of the page.
    event.preventDefault()
    this.stats.contextLost = true
    this.cancelFrame()
    this.release()
  }
  private readonly onRestored = (): void => {
    this.stats.contextLost = false
    this.build()
    this.dirtySize = true
    if (this.running) this.scheduleFrame()
  }
  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.cancelFrame()
      return
    }
    // Drop the stale timestamp so the clock resumes where it stopped rather
    // than swallowing however long the tab was in the background.
    this.lastFrameAt = null
    this.poke()
    if (this.running) this.scheduleFrame()
  }
  private readonly onActivity = (): void => this.poke()

  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas
    this.gl = gl
    this.build()

    this.observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.contentBoxSize?.[0]
      const cssWidth = box ? box.inlineSize : entry.contentRect.width
      const cssHeight = box ? box.blockSize : entry.contentRect.height
      const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR)
      this.width = Math.max(1, Math.round(cssWidth * dpr))
      this.height = Math.max(1, Math.round(cssHeight * dpr))
      this.dirtySize = true
      this.poke()
    })
    this.observer.observe(canvas)

    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    document.addEventListener('visibilitychange', this.onVisibility)
    for (const name of ['pointerdown', 'keydown', 'wheel'] as const) {
      globalThis.addEventListener(name, this.onActivity, { passive: true })
    }
  }

  // ------------------------------------------------------------- inputs ----

  /** Pressure and heat ease toward these over roughly two seconds. */
  setTargets(pressure: number, heat: number): void {
    const p = clamp01(pressure)
    const h = clamp01(heat)
    if (p !== this.targetPressure || h !== this.targetHeat) this.poke()
    this.targetPressure = p
    this.targetHeat = h
  }

  /** Skip the easing — for first paint, where there is nothing to ease from. */
  snapToTargets(): void {
    this.pressure = this.targetPressure
    this.heat = this.targetHeat
    this.poke()
  }

  /** 0 = full motion, 1 = still. Heat still colours the surface at 1. */
  setStill(still: number): void {
    this.still = clamp01(still)
    this.poke()
  }

  setPalette(palette: Palette): void {
    rampFloats(palette.cool, this.coolData)
    rampFloats(palette.dusk, this.duskData)
    rampFloats(palette.warm, this.warmData)
    this.poke()
  }

  /** Fire a ripple at a point in viewport coordinates — a checkbox, in the app. */
  rippleAtClient(clientX: number, clientY: number, strength = 1): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const aspect = rect.width / rect.height
    const x = ((clientX - rect.left) / rect.width - 0.5) * aspect
    const y = 0.5 - (clientY - rect.top) / rect.height
    this.ripple(x, y, strength)
  }

  /** Fire a ripple in aspect-corrected clip space. */
  ripple(x: number, y: number, strength = 1): void {
    this.ripples.add(x, y, this.time, strength)
    this.poke()
  }

  /** Mark interaction: cancels the idle throttle. */
  poke(): void {
    this.lastActivityAt = performance.now()
    this.stats.idle = false
  }

  // -------------------------------------------------------------- loop -----

  start(): void {
    if (this.running) return
    this.running = true
    this.lastFrameAt = null
    this.poke()
    this.scheduleFrame()
  }

  stop(): void {
    this.running = false
    this.cancelFrame()
  }

  dispose(): void {
    this.stop()
    this.observer.disconnect()
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    document.removeEventListener('visibilitychange', this.onVisibility)
    for (const name of ['pointerdown', 'keydown', 'wheel'] as const) {
      globalThis.removeEventListener(name, this.onActivity)
    }
    this.release()
  }

  private scheduleFrame(): void {
    if (this.frameHandle !== 0 || document.hidden) return
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  private cancelFrame(): void {
    if (this.frameHandle === 0) return
    cancelAnimationFrame(this.frameHandle)
    this.frameHandle = 0
  }

  private readonly frame = (now: number): void => {
    this.frameHandle = 0
    if (!this.running || this.stats.contextLost) return
    this.scheduleFrame()

    const dt =
      this.lastFrameAt === null
        ? 0
        : Math.min((now - this.lastFrameAt) / 1000, MAX_STEP_SECONDS)
    this.lastFrameAt = now
    this.time += dt * this.timeScale

    this.pressure = approach(this.pressure, this.targetPressure, dt, SETTLE_TAU)
    this.heat = approach(this.heat, this.targetHeat, dt, SETTLE_TAU)

    if (this.throttled(now)) return

    if (dt > 0) {
      const frameMs = now - this.lastDrawAt
      this.stats.frameMs = this.stats.frameMs === 0 ? frameMs : this.stats.frameMs * 0.9 + frameMs * 0.1
      this.stats.fps = this.stats.frameMs > 0 ? 1000 / this.stats.frameMs : 0
    }
    this.lastDrawAt = now

    this.draw()
    this.collectGpuTime()
  }

  /**
   * True when this frame should be skipped. Idle means: nothing touched the
   * page for ten seconds, both channels have arrived, and no ripple is alive.
   * A settled surface at 24fps is indistinguishable from one at 60 and costs
   * well under half as much.
   */
  private throttled(now: number): boolean {
    const settled =
      Math.abs(this.pressure - this.targetPressure) < SETTLED_EPSILON &&
      Math.abs(this.heat - this.targetHeat) < SETTLED_EPSILON &&
      this.ripples.activeCount(this.time) === 0

    const idle = settled && now - this.lastActivityAt > IDLE_AFTER_MS
    this.stats.idle = idle
    if (!idle) return false
    return now - this.lastDrawAt < 1000 / IDLE_FPS - 1
  }

  // --------------------------------------------------------------- GL ------

  private build(): void {
    const gl = this.gl
    const program = linkProgram(gl, vertSource, fragSource)
    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    this.program = program
    this.vao = vao
    this.buffer = buffer
    this.uniforms = {
      uTime: gl.getUniformLocation(program, 'uTime'),
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uPressure: gl.getUniformLocation(program, 'uPressure'),
      uHeat: gl.getUniformLocation(program, 'uHeat'),
      uRipples: gl.getUniformLocation(program, 'uRipples[0]'),
      uStill: gl.getUniformLocation(program, 'uStill'),
      uCool: gl.getUniformLocation(program, 'uCool[0]'),
      uDusk: gl.getUniformLocation(program, 'uDusk[0]'),
      uWarm: gl.getUniformLocation(program, 'uWarm[0]'),
    }

    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.pendingQuery = null
    this.stats.gpuMs = null
  }

  private release(): void {
    const gl = this.gl
    if (this.pendingQuery) gl.deleteQuery(this.pendingQuery)
    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.buffer) gl.deleteBuffer(this.buffer)
    this.pendingQuery = null
    this.program = null
    this.vao = null
    this.buffer = null
    this.uniforms = null
  }

  private draw(): void {
    const gl = this.gl
    const u = this.uniforms
    if (!this.program || !u) return

    if (this.dirtySize) {
      this.canvas.width = this.width
      this.canvas.height = this.height
      this.dirtySize = false
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    gl.uniform1f(u.uTime, this.time)
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height)
    gl.uniform1f(u.uPressure, this.pressure)
    gl.uniform1f(u.uHeat, this.heat)
    gl.uniform1f(u.uStill, this.still)
    gl.uniform4fv(u.uRipples, this.ripples.writeInto(this.rippleData, this.time))
    gl.uniform3fv(u.uCool, this.coolData)
    gl.uniform3fv(u.uDusk, this.duskData)
    gl.uniform3fv(u.uWarm, this.warmData)

    const query = this.beginGpuTimer()
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (query) gl.endQuery(this.timerExt!.TIME_ELAPSED_EXT)
  }

  private beginGpuTimer(): WebGLQuery | null {
    const ext = this.timerExt
    if (!ext || this.pendingQuery) return null
    const query = this.gl.createQuery()
    if (!query) return null
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    this.pendingQuery = query
    return query
  }

  /** One query in flight at a time; results arrive a frame or two later. */
  private collectGpuTime(): void {
    const gl = this.gl
    const ext = this.timerExt
    const query = this.pendingQuery
    if (!ext || !query) return
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return

    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean
    if (!disjoint) {
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
      const ms = ns / 1e6
      this.stats.gpuMs = this.stats.gpuMs === null ? ms : this.stats.gpuMs * 0.8 + ms * 0.2
    }
    gl.deleteQuery(query)
    this.pendingQuery = null
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('could not create shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error'
    gl.deleteShader(shader)
    throw new Error(`shader failed to compile:\n${log}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('could not create program')
  const vs = compile(gl, gl.VERTEX_SHADER, vert)
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  // Safe to drop once linked; the program holds its own reference.
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown error'
    gl.deleteProgram(program)
    throw new Error(`program failed to link:\n${log}`)
  }
  return program
}
