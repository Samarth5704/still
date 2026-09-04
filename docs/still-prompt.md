# Still — a todo list that calms down when you do

A build spec for Claude Code. Paste **Phase 0** first; it contains the whole
picture. Then work phase by phase, stopping between each.

---

## The idea

A task manager whose background is a live GLSL fluid surface driven by your
actual backlog. An empty list is flat, slow, cool water. Tasks accumulate and
the surface gains frequency and amplitude. Something goes overdue and it heats
and roils. Completing a task sends a ripple outward from the checkbox you
tapped.

The reward for clearing your list is **stillness** — not a streak counter, not
confetti. The shader is load-bearing: it reports a real number about your
workload that you can read without reading anything.

---

## Stack — hard constraints

- **Vite + TypeScript**, strict mode on
- **Raw WebGL2** with hand-written GLSL. No three.js, no react-three-fiber, no
  ShaderGradient, no p5, no shader library of any kind. The fragment shader is
  written from scratch in this repo.
- **No UI framework.** No React, Vue, Svelte, or Solid. Plain TypeScript modules
  and real DOM.
- **No CSS framework**, no component library, no animation library, no date
  library, no state library. Icons are hand-written inline SVG.
- **Vitest** for tests.
- The only permitted runtime external resource is a Google Fonts `<link>`.

Modern evergreen browsers only: ES modules, CSS custom properties, `@layer`,
container queries, `:has()`, `color-mix()`, `<dialog>`, View Transitions API,
WebGL2. No polyfills.

### Attribution

Three repositories informed this project and belong in the README's
acknowledgements, all MIT:

- **collidingScopes/liquid-logo** — used *offline* to generate the wordmark and
  OG image. Its output is committed as static assets; none of its code ships.
- **dashersw/liquid-glass-js** — studied for its refraction approach. Its code is
  **not** imported: it samples the page through html2canvas, which is untenable
  for a list that changes constantly, and its `Button` class produces a
  canvas-backed element rather than a real `<button>`. Glass surfaces here are
  built with `backdrop-filter` over real DOM.
- **ruucm/shadergradient** — studied for its parameter space. Not a dependency.

State this plainly in the README. Borrowing ideas and crediting them is normal;
implying you wrote something you imported is not, and implying you imported
something you wrote sells yourself short.

---

## Phase 0 — read this, then start Phase 1

Build in the order below. **Stop after each phase and show me the result.** Do
not run ahead.

1. Data model and pure logic, with tests. No UI, no shader.
2. The shader, standalone, on its own page with sliders. Not wired to the app.
3. App shell and the task list.
4. Task detail, subtasks, projects, tags.
5. Recurrence.
6. Calendar and agenda views.
7. Wire the shader to real data; glass surfaces.
8. Performance, accessibility, CI, README.

Phase 2 sits before the app deliberately. Tuning a shader while an app is in the
way is miserable; build it against sliders first, get it beautiful, then connect
it.

---

## Phase 1 — data model and pure logic

TypeScript types and pure functions only. No DOM access anywhere in `lib/`.

### Types

```ts
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

type Task = {
  id: string
  title: string
  notes: string
  done: boolean
  completedAt: string | null      // ISO instant
  due: string | null              // 'YYYY-MM-DD'
  dueTime: string | null          // 'HH:mm', optional time of day
  priority: Priority
  projectId: string | null
  tagIds: string[]
  parentId: string | null         // subtasks: one level only, not a tree
  order: number                   // manual sort within its list
  recurrenceId: string | null
  createdAt: string
}

type Project = { id, name, colorToken, icon, archived: boolean, order: number }
type Tag     = { id, name, colorToken }

type Recurrence = {
  id: string
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number                     // every N units
  byWeekday?: number[]                 // 0–6, for weekly
  byMonthDay?: number                  // 1–31, for monthly-by-date
  byNthWeekday?: { nth: number; weekday: number }  // nth may be -1 = last
  byMonth?: number                     // 1–12, for yearly
  starts: string                       // 'YYYY-MM-DD'
  ends: { type: 'never' } | { type: 'after'; count: number }
       | { type: 'until'; date: string }
  exceptions: RecurrenceException[]
}

type RecurrenceException = {
  date: string                    // the occurrence date being modified
  kind: 'skipped' | 'completed' | 'moved'
  movedTo?: string
  completedAt?: string
}

type Settings = {
  schemaVersion: number
  theme: 'dark' | 'light' | 'system'
  effects: 'full' | 'reduced' | 'off'
  weekStartsOn: 0 | 1
  defaultProjectId: string | null
}
```

### Hard rules

1. **Dates are `'YYYY-MM-DD'` strings**, never `Date` objects in state. A task is
   due on a calendar day, not at an instant. `Date` appears only inside
   `lib/dates.ts` for reading today and for arithmetic.
2. **Subtasks are one level deep, not a tree.** A task with a `parentId` cannot
   itself have children. Enforce this in the store. Arbitrary nesting is a
   feature nobody uses and a source of cycle bugs; one level covers checklists,
   which is what people actually want.
3. **Recurring tasks store a rule, never materialised instances.** Occurrences
   are generated lazily for a bounded date window. A rule with
   `ends: { type: 'never' }` must never produce an unbounded array — every
   generator takes an explicit window and a hard cap.
4. **Completing a recurring task completes one occurrence**, recording a
   `'completed'` exception, and the next occurrence becomes current. It never
   mutates the rule.
5. All aggregation and generation functions are pure, take their inputs
   explicitly — including "today" — and never read the clock internally.

### `lib/recurrence.ts` — the hard part

`occurrencesBetween(rule, windowStart, windowEnd, cap)` returns date strings.

Must handle correctly:

- **Monthly-by-date overflow.** The 31st in a 30-day month, and in February.
  Decide and document the policy — skip the month, or clamp to the last day.
  Pick clamping; skipping silently loses a task the user expected.
- **Monthly by nth weekday**, including `nth: -1` for last. "Last Friday of the
  month" is a common real rule.
- **Leap years.** A yearly rule on 29 February.
- **Weekly with an interval > 1** and a weekday set. "Every other week on Tue and
  Thu" must anchor its week-parity to `starts`, not to the window, or scrolling
  the calendar backwards will shift every occurrence.
- **`ends.after`** counts occurrences from `starts`, not from the window. A
  window starting mid-series must still know how many came before it.
- **Exceptions** are applied after generation: skipped dates are removed, moved
  dates are relocated, completed ones are marked.

Write these as tests before you write the implementation.

### `lib/pressure.ts` — the number that drives everything

Two output channels in `[0, 1]`, both pure functions of the open task list and
today's date.

**`pressure`** — how much is on your plate.

Each open task contributes `priorityWeight × urgencyMultiplier`:

- priority weights: none 1, low 1.5, medium 2.5, high 4, urgent 6
- urgency: overdue → `2 + min(daysOverdue, 14) / 7`; due today → 2; due within
  three days → 1.5; due later → 1.1; no due date → 1

Sum to a raw load, then **normalise with a saturating curve**, not linearly:
`pressure = 1 - exp(-load / k)`, with `k` tuned so that a realistic busy day
lands around 0.6 rather than pinning at 1. Linear normalisation would make
twenty tasks look identical to two hundred, and would make the shader jump every
time a single task is added to a short list.

**`heat`** — how much of that load is late. The fraction of raw load contributed
by overdue tasks. An empty list is `heat = 0`; a list where everything is
overdue is `heat = 1`.

Two channels rather than one because they mean different things and should drive
different uniforms: pressure moves frequency and amplitude, heat moves the
palette. A calm-but-late list and a busy-but-current list should not look the
same.

### Tests for Phase 1

- **Recurrence:** every case named above, each as its own test. Plus: a `never`
  rule with a one-year window returns a bounded array; the cap is respected; an
  `until` date that falls mid-window truncates correctly.
- **Pressure:** empty list is 0. One low-priority task with no due date is near
  0. Adding tasks increases pressure monotonically. Doubling a large list moves
  pressure less than doubling a small one (this is what proves the curve
  saturates). Pressure never exceeds 1 with 10,000 tasks.
- **Heat:** 0 with nothing overdue, 1 with everything overdue, and correct
  fractions in between. Never `NaN` on an empty list.
- **Dates:** month-end arithmetic, leap years, week boundaries across a month
  edge, `YYYY-MM-DD` strings sorting chronologically.
- **Subtasks:** a task with a `parentId` cannot be given children. Deleting a
  parent handles its children explicitly (see Phase 4).
- **Storage:** malformed JSON falls back to defaults; an unknown future
  `schemaVersion` fails safe and puts the app in read-only rather than
  overwriting.

Show me the passing suite, then stop.

---

## Phase 2 — the shader, standalone

A separate page (`shader.html`) rendering the fragment shader full-screen with a
control panel of sliders. The app does not exist yet.

### Approach

One full-screen quad, WebGL2, one fragment shader. No geometry, no camera, no
scene graph — this is a 2D effect and treating it as 3D would be the mistake the
whole stack decision was made to avoid.

Build the surface from layered simplex or gradient noise (write the noise
function; it's about 30 lines of GLSL), domain-warped so it flows rather than
scrolls. Add a soft specular term so the surface reads as liquid rather than as
a blurred gradient.

### Uniforms

```glsl
uniform float uTime;
uniform vec2  uResolution;
uniform float uPressure;    // 0..1
uniform float uHeat;        // 0..1
uniform vec4  uRipples[8];  // xy = origin in clip space, z = start time, w = strength
uniform float uStill;       // 0..1, master damping for reduced-effects mode
```

How the inputs read visually:

- **pressure** → noise frequency, warp strength, and flow speed. At 0 the
  surface is nearly flat and moves slowly; at 1 it is dense and agitated.
- **heat** → palette interpolation from cool (deep teal / indigo) toward warm
  (amber / oxblood), plus a rise in specular sharpness. Colour carries lateness.
- **ripples** → expanding rings from a point, displacing the surface, decaying
  over about 1.2 seconds. Ring buffer of 8; a ninth overwrites the oldest.

Interpolate `uPressure` and `uHeat` toward their targets over roughly two
seconds rather than snapping. Adding one task should feel like the tide turning,
not a jump cut.

### Non-negotiable engineering

1. **Handle context loss.** Listen for `webglcontextlost` (call
   `preventDefault()`) and `webglcontextrestored` (rebuild all GL state). GPU
   driver resets and tab backgrounding both trigger this, and almost every hobby
   WebGL project dies permanently when it happens.
2. **Cap device pixel ratio** at 1.5. A 3× DPR phone rendering a full-screen
   fragment shader at native resolution will thermally throttle.
3. **Stop the render loop when the tab is hidden** — `visibilitychange`, cancel
   the rAF, and resync `uTime` on return so the surface doesn't jump.
4. **Idle throttle.** With no interaction and stable pressure for 10 seconds,
   drop to ~24fps. Return to full rate on any input or state change.
5. Request the context with `powerPreference: 'low-power'` and
   `antialias: false`.
6. **A static fallback that is not an afterthought.** If WebGL2 is unavailable,
   render a CSS gradient built from the same palette and driven by the same
   pressure and heat values via custom properties. It should look deliberate,
   not broken.

### Control panel

Sliders for every uniform plus the palette stops, and a button that fires a
ripple at the cursor. This page is a development tool; it ships to the site but
is not linked from the app. Keep it — a reviewer clicking it and dragging the
pressure slider is the fastest possible demonstration of what the project does.

Show it running, then stop. I will want to tune the look before you wire it up.

---

## Phase 3 — app shell and task list

- Header with the wordmark and a pressure readout in words, not just colour
  ("Calm" / "Steady" / "Busy" / "Heavy", with a separate "· 3 overdue").
- Views in a sidebar (desktop) or bottom bar (mobile): Today, Upcoming, All,
  Calendar, plus the project list.
- **Quick add** as the primary input, always focusable with `/`. Parse inline:
  - `tomorrow`, `today`, `next tue`, `23 dec`, `in 3 days`
  - `!!` / `!!!` for priority, `#project`, `@tag`
  - `every monday`, `every 2 weeks`, `every last friday` → creates a recurrence
  - a live preview under the input showing exactly what was parsed
  - every parse rule gets a test
- The list: title, due chip, priority indicator, project dot, tag chips, subtask
  progress (`3/5`). Grouped by due date in Today and Upcoming; manually ordered
  in a project.
- **Completing a task** ticks it, removes it after a short beat, fires a ripple
  at the checkbox's position, and offers undo for 8 seconds. The undo must be
  keyboard-reachable before it expires.
- Manual reordering that works by keyboard, not drag-only.
- Filters and the active view live in the URL hash so any view is linkable.

Bare "No tasks" is not acceptable. An empty Today is the *goal state* of this
app — design it as a reward, and let the surface go still behind it.

---

## Phase 4 — detail, subtasks, projects, tags

Task detail opens in a `<dialog>`: title, notes, due date and optional time,
priority, project, tags, subtasks, recurrence.

**Subtask semantics, decided explicitly rather than discovered:**

- The parent shows progress (`3/5`) and is never auto-completed by its
  subtasks. Completing the last subtask surfaces a quiet prompt to close the
  parent; it does not close it. Deciding a task is finished is the user's call.
- Completing the parent completes its remaining subtasks, silently and
  undoably.
- Deleting a parent asks: delete the subtasks too, or promote them to top level,
  with counts stated both ways.
- Subtasks do not carry their own due dates, projects, or recurrence. They are
  checklist items. Keeping them thin is what stops this becoming a tree.

Projects and tags: create, rename, recolour, archive. Archiving rather than
deleting when items reference them, so a completed task from last month still
resolves the name it was filed under. Deleting anyway requires an explicit
reassign-or-delete choice with counts.

---

## Phase 5 — recurrence UI

Budget more time for this than for the shader.

- A recurrence editor: frequency, interval, weekday set for weekly, by-date or
  by-nth-weekday for monthly, end condition. Show a plain-language summary of
  the rule as it is built — "Every 2 weeks on Tuesday and Thursday, until 15
  December" — and a preview of the next five occurrences. If a user cannot read
  back what they built, they will not trust it.
- Completing an occurrence advances to the next and records the exception.
- **Editing a recurring task asks for scope**: this occurrence only, this and
  all future, or the whole series. "This and future" splits the rule in two —
  end the original at the day before, create a new one from that date. This is
  the correct approach and it is the one most implementations skip.
- Skipping an occurrence without completing it.
- Show, on the task, how many occurrences remain when the rule has an end.

---

## Phase 6 — calendar and agenda

- **Month grid** with tasks per day, generated by pulling recurrence occurrences
  for exactly the visible window plus a small margin. Never generate the whole
  series.
- **Agenda** as a scrolling chronological list, grouped by day, with the empty
  days visible rather than collapsed. An empty week is information.
- Both are keyboard-navigable: arrow keys move by day, Page Up/Down by month,
  Home/End to the week's edges.
- Clicking a day filters the list rather than opening a modal.
- Today is marked in a way that survives greyscale.

---

## Phase 7 — wire it up, and the glass

Connect real `pressure` and `heat` to the shader. Fire ripples from real
completions at the real screen position of the checkbox.

**Glass surfaces**, built with `backdrop-filter: blur() saturate()` over real
DOM — not with a canvas, not with html2canvas, not by importing liquid-glass-js.
A one-pixel inner highlight along the top edge and a soft outer shadow tinted
from the surface below. Cards, the header, and dialogs all sit on glass; the
shader shows through and moves behind them.

**The rule that governs everything here: text never sits directly on the
shader.** Every text-bearing surface has a scrim with a guaranteed minimum
opacity beneath it. The shader is background, and background it stays.

---

## Phase 8 — performance, accessibility, CI, README

### Performance budget, measured and reported

- 60fps sustained on a mid-range laptop with 200 tasks
- The shader costs under 4ms per frame at 1440×900, DPR capped at 1.5
- No layout thrash: the render loop touches no DOM and reads no layout
- The list reconciles keyed nodes; it never re-renders with `innerHTML`
- Report actual measured numbers, not assurances

### Accessibility

- **The shader carries information, so it needs a text equivalent.** A
  visually-hidden live summary — "Steady. 12 open tasks, 3 overdue." — updated
  on change, at a sensible granularity rather than on every frame. A user who
  cannot see the surface must not lose what it says.
- `prefers-reduced-motion: reduce` → the static fallback gradient, no ripples,
  no flow. Not a slower animation; none.
- An **effects preference** independent of the OS setting: full / reduced / off.
  Off means the CSS gradient and nothing running.
- **Contrast must be verified against the shader's whole palette range, not one
  screenshot.** Sample the palette at a grid of pressure and heat values, take
  the worst case behind each scrim, and assert 4.5:1 holds at every point.
  Write this as a script and run it in CI. This is the interesting accessibility
  problem in this project — a moving background means contrast is a range, not a
  number.
- Full keyboard operation, visible `:focus-visible` at every stop, `<dialog>`
  trapping focus and restoring it to its trigger.
- Task rows are `<li>` in a `<ul>` with real `<button>` controls, each named in
  context — "Complete: Submit finance assignment, due tomorrow" — not three
  hundred identical "Complete"s.
- Completion and undo announced politely; nothing conveyed by colour alone.
- Touch targets at least 44×44px. No horizontal scroll down to 320px.

### CI

GitHub Actions: typecheck, Vitest, and the contrast script, all failing the
build. Deploy to Pages from the Vite build output.

**Publish an explicit allowlist of what gets deployed** rather than uploading
the build directory blind, and fail the build on an unclassified top-level
entry. Scratch pages and reference material must not be able to reach a public
URL by accident.

### README

Screenshots, live demo, local setup, and a **Design notes** section covering: why
pressure saturates instead of scaling linearly; why pressure and heat are two
channels rather than one; why recurrence stores a rule rather than instances and
what "this and future" actually does to that rule; why the shader is hand-written
rather than imported; and how contrast is verified across a moving background.

Plus the acknowledgements described at the top of this document.

---

## Out of scope — do not build

No backend, database, accounts, auth, or sync. No collaboration or sharing. No
notifications or reminders. No natural-language date parsing beyond the listed
patterns. No AI features. No import from other todo apps. No three.js, no
framework, no shader library.
