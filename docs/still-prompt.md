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
type Tag     = { id, name, colorToken, archived: boolean }
             // archived added in Phase 4: see "Settled during Phase 4" below

type Recurrence = {
  id: string
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number                     // every N units
  byWeekday?: number[]                 // 0–6, for weekly
  byMonthDay?: number                  // 1–31, for monthly-by-date
  byNthWeekday?: { nth: number; weekday: number }  // nth may be -1 = last
  byMonth?: number                     // 1–12, for yearly
  starts: string                       // 'YYYY-MM-DD'
  weekStart: 0 | 1                     // WKST: parity basis, seeded from
                                       // settings.weekStartsOn at creation,
                                       // never re-read from settings after
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

`occurrencesBetween(rule, windowStart, windowEnd, cap, { weekStart })` returns
`Occurrence` records:
`{ date, seq, status, movedFrom?, movedTo?, completedAt? }`, where `seq` is the
0-based index of the occurrence within the series counted from `starts`, and
`status` is `'pending' | 'completed' | 'skipped' | 'moved'`.

`occurrenceDatesBetween(...)` is a thin `.map(o => o.date)` over the same call —
never a second traversal, so the calendar and the list can never disagree about
what exists.

Must handle correctly:

- **Monthly-by-date overflow.** The 31st in a 30-day month, and in February.
  Decide and document the policy — skip the month, or clamp to the last day.
  Pick clamping; skipping silently loses a task the user expected.
- **Monthly by nth weekday**, including `nth: -1` for last. "Last Friday of the
  month" is a common real rule.
- **Leap years.** A yearly rule on 29 February.
- **Weekly with an interval > 1** and a weekday set. "Every other week on Tue and
  Thu" must anchor its week-parity to the week containing `starts`, not to the
  window, or scrolling the calendar backwards will shift every occurrence. That
  week is computed under the rule's own `weekStart` (RFC 5545 WKST). Reading the
  parity basis from settings at generation time is wrong: changing the app's
  week-start preference would silently move every existing biweekly rule.
  `weekStart` only affects rules with `interval >= 2`.
- **`ends.after`** counts occurrences from `starts`, not from the window. A
  window starting mid-series must still know how many came before it. The
  generated series is a function of the rule alone: exceptions filter and
  annotate it, but never change its length or its dates. A skipped occurrence
  still consumes one of the `count`, and a moved occurrence keeps its `seq`.
  Because a skip silently burns a count, the UI must show it — the editor's
  summary reads "10 times" with the final date, and the task reads "3 of 10
  scheduled", never a bare "3 left" (Phase 5).
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

### Settled during Phase 2 — read before wiring the real signal in Phase 7

Three things were decided at the shader by looking at the output, not by
reasoning about it. They constrain what Phase 7 may assume.

**There is a frequency floor, and calm depends on it.** Noise frequency ranges
over `mix(1.30, 5.00, pressure)` rather than starting near zero. Below about one
cycle per screen the entire viewport falls inside a single noise lobe, so the
picture becomes whatever sign that lobe happens to have: an empty list rendered
as an arbitrarily bright or dark wash that drifted as the field moved under it.
The goal state of this app cannot be a coin toss. With the floor in place, an
empty list holds a mean luminance of 51.1–52.3 over a 200-second sweep. Pressure
also seats the surface on its ramp — `level = mix(0.18, 0.54, pressure)` — so a
cleared list rests near the deep end. Without that, clearing your list made the
screen *brighter*, which is backwards.

**Heat travels through a third ramp, `DUSK`.** Teal and oxblood are near-opposite
hues, so a componentwise mix between them desaturates to grey at the midpoint —
and "half my load is overdue" is a common state that was rendering as dirty
dishwater. Heat now walks cool → dusk (plum) → warm in two linear segments,
mirrored exactly between `palette.ts` and the GLSL. A test asserts the mid stop
never drops below 0.06 chroma anywhere along the path. Phase 8's contrast script
must sample all three ramps, not two.

**`uStill` is not a mute switch.** It damps flow and warp only. Frequency,
relief, level and palette continue to follow pressure and heat, so a
reduced-effects user still sees a surface that is denser when they are busy and
warmer when they are late — it simply holds still. Ripples are damped to nothing.
The CSS fallback makes the same bargain, encoding pressure through `--sf-spread`
and heat through the ramp. Stillness removes motion; it never removes
information. Phase 7 must not treat `uStill = 1` as "the shader is off", and
Phase 8's effects preference inherits this: *reduced* is a still surface that
still reports, *off* is the fallback, which also still reports.

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

### Settled during Phase 4 — read before Phase 5

**`Tag` gained `archived: boolean`.** The Phase 1 type block above listed
`Tag = { id, name, colorToken }`, but this phase requires archiving for *both*
catalogues and a tag has exactly the same problem a project does: a completed
task carries it, so deleting the name either rewrites history or leaves a
dangling reference. The field is additive — `parseTag` defaults it to `false`,
so data written before it existed loads as live, which is what it was — and it
needed no schema bump. The type block has been corrected to match.

Tag deletion offers *untag* where project deletion offers *delete the tasks*.
Same shape of choice, different stakes: a tag is one chip among several, not
the file the task lives in, so destroying a task over a retired label would be
a disproportionate answer to the question being asked.

**Every way out of a dialog is a dismiss, not a cancel.** Task detail saves as
you go, so the close button, Done, Escape and a backdrop click all do exactly
the same thing and none of them discards anything. That leaves one hole a
save-as-you-go dialog can still fall into — `change` fires when a field is
*left*, and Escape closes the dialog out from under the caret — so a field
typed into but not yet left records its commit and is flushed explicitly on the
way out, rather than trusting the browser to fire blur-then-change in that
order on close. Because nothing can be lost there is no "discard changes?"
prompt; the footer says "Changes save automatically", since a user expecting
Escape to cancel would otherwise learn the rule by losing something. Phase 5's
recurrence editor is a bigger, more modal thing to build inside this dialog —
if any part of it needs a genuine cancel, it must say so and hold its own
draft, because the surrounding contract is that closing keeps your work.

**Focus restoration needs a named fallback, not a stored trigger.** A dialog
restores focus to whatever opened it, but the edit made inside can destroy that
control: completing a task removes its row, changing a due date moves the row
out of Today, deleting a project takes its line out of the manage list.
`focus()` on a detached node does nothing and focus lands on `<body>`, which
ends keyboard navigation until the user tabs in from the top of the page.
`restoreFocus` in `app/dom.ts` takes the preferred node plus ordered fallbacks
and verifies each one actually took focus — connected is not the same as
focusable, and an inert node accepts the call and changes nothing. The chains:
task detail falls back to the view heading, then quick add; the manage dialog
to the header button, then the heading; the question dialog to a control inside
the dialog underneath, because a fallback outside a modal that is still open is
inert and will silently refuse. The task list uses the same helper when the
completed row was the last one.

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

### Settled during Phase 5 — read before Phase 6

**The task *is* the series.** There is one `Task` per recurring rule, never one
per occurrence, and its `due` is the occurrence it is currently sitting on.
Everything else follows: ticking it records a `'completed'` exception and walks
`due` forward, skipping records a `'skipped'` one and does the same, and
exhausting the rule is the only thing that sets `done`. `lib/series.ts` holds
those operations and `recurrence.ts` still holds the generator, so the "what
dates does this rule produce" question and the "what happens when you tick it"
question never answer each other.

Phase 6 therefore cannot find an occurrence's task by looking for one: to put
occurrences on a month grid it must pull them from `state.recurrences` for the
visible window and attribute each to the task carrying that rule. The task's
`due` names only the current occurrence, not the ones either side of it.

**No new field on `Task`.** The Phase 1 type block stands unchanged, which is
why the `SUBTASK_STRIPPED` classification needed no new entry. The scope of an
edit is not data — it is state for the length of one visit to the detail
dialog.

**`setDone` routes repeating tasks away from itself.** There is one way to tick
a task and it always does the right thing, rather than every caller — the list
checkbox, the close-the-parent prompt, a keyboard shortcut — having to remember
which kind of task it holds. Completing an occurrence also unticks the
subtasks: a repeating task's checklist belongs to the occurrence, so next
week's review starts empty.

**Position, never remainder.** A skipped occurrence still consumes one of an
`ends.after` count, so "7 left" would quietly stop being true the first time
anybody skipped one. The task and the editor both read `3 of 10 scheduled`, and
the editor's summary states the count with the date it lands on — "10 times
(ending 14 January 2026)". Counting an `until` rule means generating it, so
`totalOccurrences` refuses past a thousand and the UI drops the position rather
than showing a number it had to strain for.

**"This and all future" really does leave two rules.** The original is ended
the day before the split and the new one starts on it, with an untouched
`ends.after` carried across as *remaining* rather than restated — ten times
that has already run three becomes seven, not ten again. The truncated original
is kept only when it carries exceptions: with no task pointing at it, a husk
with no history in it is storage weight nothing can ever render, while one with
completions in it is the record of what was actually done, which is Phase 6's
to draw.

**The recurrence editor is the one dialog with a genuine Cancel**, and Phase 4
said it would have to declare itself if it did. A rule is built from parts that
are only meaningful together — halfway between "every Monday" and "the last
Friday of every month" the draft is a monthly rule with a weekday set and no
month day — so it holds its own draft, commits nothing until Save, and says
"Cancel discards this repeat" in its footer where the button is. It resolves a
promise rather than writing to the store, because what a new rule *means* for
an existing series is the store's decision, not the dialog's.

**The scope question is asked once per visit, on the first edit.** Not on open,
which would interrupt someone who came to read; not per field, which would ask
five times to change a title, a date and a priority. The answer is then shown
in the repeat section with a way to change it, so a scope chosen in passing is
never invisible. Editing the rule itself asks a two-way version of the same
question — a rule that applies to one occurrence is not a rule, which is what
Skip and a moved date are for.

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

### Settled during Phase 6 — read before Phase 7

**The calendar reads rules, not tasks.** `lib/calendar.ts` builds one map of
day → entries for exactly the window on screen, and both the grid and the
agenda are shapes over that one answer, so they cannot disagree about what a
Tuesday holds. Plain tasks come from their `due`; a repeating task comes from
its rule and never from its `due`, or the occurrence it is currently sitting on
would be drawn twice and the ones either side of it not at all. Every call is
still a bounded window over the bounded generator — the per-rule cap is the
window's own length, because a rule cannot put two occurrences on one day
unless one was moved there.

**A rule left behind by a split keeps its title through the shape of the
split.** `splitSeries` ends the original the day before its successor starts,
so an orphaned rule is matched to the task by following that chain forward
until a rule a task points at is reached. Two rules starting on the same day
are ambiguous and link to nothing: a mis-titled completion is worse than a
missing one. Only the *finished* occurrences of an orphan are drawn — its
pending dates are unreachable, and a checkbox that cannot do anything is worse
than a blank square.

**Focus and selection are different things, and both had to exist.** Arrow
keys move focus without committing; Enter or Space selects, which filters the
day list and writes the day into the URL. Selecting on every arrow key would
push a history entry per keystroke and re-announce the panel seven times
crossing a week, so each focus move announces the day it landed on instead.
Focus is only ever reset from outside when the *selection* changes — comparing
it against the focused day instead is how every arrow key gets snapped straight
back, which looks exactly like a grid with no keyboard support at all.

**The selected day is in the URL, but with `replaceState`.** A day is a filter,
not a destination: Back should leave the calendar rather than walk through
every day someone looked at. That also means no `hashchange`, and therefore no
focus move to the view heading — which is what keeps the arrow keys inside the
grid where the user put them. `sameView` ignores the day so the nav link stays
lit; `sameHash` is the strict question, and routing is the only thing that asks
it.

**Only the current occurrence gets a checkbox.** `setDone` acts on the task,
and a repeating task's `due` is the one occurrence it is sitting on — so a
checkbox on next Monday's cell would tick *this* Monday's. Everything else on
the grid carries a mark and a word instead: `completed`, `skipped`, or
`scheduled`.

**Today is marked by luminance, not hue**: the numeral is knocked out of a
filled disc, the only disc on the grid, and `aria-current="date"` says the same
thing to anyone not looking.

**Below 520px the dot is the whole entry, so the statuses are shapes.** The
cells drop their task names at that width, which means a strike-through on
hidden text says nothing and the dot has to carry the state on its own. Filled
disc is outstanding, open ring is done, flat dash is skipped — three
silhouettes, because a fill or lightness difference is the colour-alone failure
wearing different clothes, and it is also exactly what a low-priority task
already looks like. The dot grows to 9px there, since a 1.5px ring inside a 6px
disc leaves a 3px hole that is not a shape anybody can read. The same three
states are in the cell's `aria-label`, where `dayLoadLabel` counts *done* and
*skipped* separately rather than summing them as "finished": that string is all
a screen reader gets from a dot, and a day waved away is not a day completed.

**One fetch per render.** The grid, the agenda and the day panel all want the
same days, so they are three shapes over one `CalendarWindow` rather than three
calls to `entriesBetween` — which walks every rule in the state, and would make
the one-day panel pay the full per-rule cost of the whole month. Paging a month
therefore costs one more pass over the rules, not one per cell; measured at
**1.8 ms** for a 56-day window over 300 tasks and 40 rules (395 entries), with
the one-day fallback the day panel uses when it is showing a day off the month
on screen at **0.43 ms**. `src/app/calendar.cost.test.ts` counts the calls, so
the shape of that cost cannot regress silently even where the timing would be
too flaky to assert.

**Empty days keep their rows.** The agenda lists every day of the month
including the ones with nothing on them, and each says so in words. An empty
week is information, and collapsing it is how a quiet fortnight comes to look
like a missing one.

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

### Settled during Phase 7 — read before Phase 8

**The surface reads the store, not the list.** `app/surface.ts` is handed a
`PressureSummary` and the effects setting, and knows nothing else — not what a
task is, not what "overdue" means. `lib/pressure.ts` had already turned the
backlog into two numbers, so the header's word, the live summary and the
shader are three readings of one definition rather than three definitions that
happen to agree today. Nothing in that module runs per frame; the renderer's
loop is still the only thing that does, and it still touches no DOM.

**The first paint snaps; everything after it eases.** The two-second approach
is the point of the whole channel — adding a task should read as the tide
turning — but there is nothing to ease *from* on load, and easing anyway means
a user with nine overdue tasks watches their backlog arrive as an animation
that looks like a loading state for something already loaded.

**The tinted shadow comes from the palette, not from the pixels.** Phase 7 asks
for "a soft outer shadow tinted from the surface below", and the tempting
reading is to sample the framebuffer — which puts a GPU readback in front of
every paint and is exactly the approach liquid-glass-js was studied for and
rejected over. `gl/tint.ts` derives it from the same ramp the shader is handed:
`--glass-tint` is rewritten on `:root` whenever heat moves, so a late list casts
a red-black shadow and a clear one a blue-black shadow, and a test sweeps the
whole range asserting the shadow is never lighter than the trough it falls on.
It is set in fallback mode too, because in fallback mode that ramp is still
what is behind the chrome.

**"Text never sits on the shader" cost more than it sounds.** Six surfaces were
carrying text with nothing beneath them, and every one of them looked correct
through Phase 6 because the thing behind the app was a fixed gradient that
never moved. The list rows were the worst of them: 0.55 alpha, which is a tint,
not a scrim, and a crest passing under a task title. They now use `--glass-bg`
like everything else — the floor is one token so Phase 8's contrast script has
one number to sample rather than a dozen hand-rolled alphas. The two headings
and the group labels sit on plates sized to the words rather than full-width
bars, so the surface still fills the rest of the row; the calendar's month
name, stepper, "Today" and layout switch share one strip, because plating four
controls separately is a worse-looking way to obey the same rule; and the
read-only banner composites its warn wash *over* the scrim instead of using it
as one. `style.test.ts` holds the list and rejects a wash in any block that
never names the floor.

**`--ink-faint` did not survive the move.** The dimmest ink in the palette was
chosen against a still gradient and is the first thing to go on a plate over a
moving surface, so the group labels stepped up to `--ink-dim`. They are still
quieter than the rows.

**Ripples are an event, not a call.** Completions dispatch `still:ripple` with
the checkbox's own screen position and the surface listens on `window`. The
list, the detail dialog's subtasks and the calendar all fire the same event
without importing anything from `gl/`, and the surface never learns which one
it came from.

**`reduced` is not `off` and neither one is silent.** `resolveMode` is a pure
table: no WebGL2 or `off` gives the CSS fallback, `reduced` gives a still
shader, `full` gives a moving one. `uStill` damps flow, warp and ripples to
nothing, so frequency, relief, seat level and palette still follow pressure and
heat — collapsing `reduced` to the gradient is the tempting simplification and
it quietly removes information from the users most likely to need it. `off`
stops the loop rather than hiding it; a cancelled rAF is the difference between
"effects off" and "effects invisible and still costing a GPU".

**`effects` gained a fourth value, `auto`, and it is the default.** It is the
same three-way shape as `theme` and it exists for the same reason: with three
values an explicit `full` is indistinguishable from the default `full`, so
following `prefers-reduced-motion` would overrule someone who asked for motion
and ignoring it would overrule someone who asked for none. Only `auto` asks the
OS; the other three outrank it in both directions, which is what makes the
preference independent of the system setting rather than merely unaware of it.
Phase 8's control has four options to draw, not three.

The media query is **listened to**, not read at boot. A preference that only
takes effect on the next reload is one the user has to discover is a reload
away. The change handler re-resolves the mode and deliberately does not touch
the pressure and heat targets — the backlog has not moved, and re-running
`apply` would restart the two-second ease every time an OS setting was toggled.
A motion change can never enter or leave the fallback, because only WebGL2 and
an explicit `off` choose it, which is what lets the handler skip repainting the
gradient.

**Schema 1 → 2 migrates a stored `full` to `auto`.** Schema 1 defaulted to
`full` and shipped no way to change it, so every stored `full` is a default
nobody picked; reading it back as a choice would leave those users with an
animated background that ignores their OS preference for good. The version bump
is what stops the migration running once an effects control exists and a stored
`full` becomes a real choice. `reduced` and `off` are carried across untouched —
they could only ever have been set deliberately.

**`--glass-tint` is written only when the colour changes.** A custom property on
`:root` invalidates every rule that reads it, so each write is a document-wide
style recalc. This was never per-frame — `apply` runs per store change and reads
the *target* heat, while the ease happens inside the renderer — but a burst of
edits still produced one invalidation each, measured at **60 writes in 44 ms
across 30 quick-adds, every one of them the same colour**. The dedupe is string
equality on the resolved 8-bit colour rather than an epsilon on heat: the string
*is* the paint, so two heats that round to the same triple are the same pixel
and anything that survives the comparison is a change someone could see. The
shader's ease is untouched and stays smooth; CSS is simply no longer dragged
along with it.

**The scrim rule has a guard that catches code nobody has written yet.**
`style.test.ts` names the six surfaces this phase fixed, which proves those six
do not regress and proves nothing about the seventh. `app/scrim.test.ts` boots
the real app under happy-dom, renders every view, walks every element that
carries a text node, and requires each one to reach a scrim before it reaches
the page — with the set of scrim-bearing classes *derived from the stylesheet*,
so painting `var(--glass-bg)` in a new rule is all it takes to register one. A
new panel added without a scrim fails on the day it is written and the failure
names the element and quotes its text. It cannot resolve the cascade — happy-dom
has no `@layer` — so it asks about containment rather than pixels; contrast
across the palette range is still Phase 8's script, and this is the structural
question underneath it.

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
