# Accessibility — what was built, what was measured, what was not met

Phase 8's audit, recorded so it can be checked rather than taken on trust. The
measurements were taken on 6 September 2026 in Chrome, at a 320px viewport
unless a section says otherwise, by walking every view and every dialog in the
running app.

Three of these claims are held by tests that run on every commit; the rest are
measurements, and this file is where they live so that "we measured it" has an
address.

## Held by a test

| Claim | Held by |
|---|---|
| Contrast clears 4.5:1 against the shader's whole palette range, in both themes, under every scrim and wash | `npm run contrast`, in CI |
| No text sits directly on the shader, in any view or dialog, including ones written later | `src/app/scrim.test.ts` |
| Every element that sets `display` and is hidden from script has a `[hidden]` opt-out | `src/style.test.ts` |
| The effects preference has four values and `auto` is the default | `src/app/dialogs.test.ts`, `src/app/surface.test.ts` |
| An explicit effects choice outranks the OS in both directions | `resolveMode` / `resolveEffects` tables in `src/app/surface.test.ts` |
| Reduced effects keeps the information and removes only the motion | same, plus the `uStill` behaviour settled in Phase 2 |

## The shader's text equivalent

The surface reports two real numbers, so it needs a reading that does not
require seeing it. There are three, and they are three renderings of one
definition in `lib/pressure.ts` rather than three descriptions that happen to
agree:

- the header, visibly: **Heavy · 12 open · 10 overdue**
- a visually-hidden `role="status"` region: *"Heavy. 12 open tasks, 10
  overdue."*, rewritten only when the sentence changes — never per frame
- the preferences dialog, for what the surface is *doing*: *"Your system asks
  for full motion. The surface is flowing."*

The canvas itself is `aria-hidden`. Announcing it adds a stop on the way to the
task list and carries none of the information.

## Motion

`prefers-reduced-motion: reduce` is followed by the `auto` setting, which is the
default. It resolves to a **still shader**, not to the CSS gradient: `uStill`
damps flow, warp and ripples to nothing while frequency, relief, seat level and
palette still follow pressure and heat. Collapsing it to the gradient is the
tempting simplification and it removes information from the users most likely to
need it.

`off` is the setting that stops the loop. Not hides — stops; a cancelled
`requestAnimationFrame` is the difference between "effects off" and "effects
invisible and still costing a GPU".

The media query is listened to, not read at boot, so turning reduced motion on
while the app is open takes effect immediately rather than at the next reload.

## Targets and reflow, measured

At 320px, in Today, Upcoming, All, Calendar and all four dialogs:

- `document.documentElement.scrollWidth` is **320** in every view. No horizontal
  scroll, and no element's right edge past the viewport.
- Every interactive control is at least 44 × 44px — after this phase raised
  three groups that were not:

| Control | Was | Now |
|---|---|---|
| Text fields, selects, the notes area | 40px (`2.5rem`) | `var(--tap)` |
| The undo button | 36px | `var(--tap)` |
| The calendar's "Today" and Month/Agenda switch | 31.6px | `var(--tap)` |

Radio rows in the preferences dialog measure 16.8px if you measure the
`<input>`. The whole `.choice` row is the `<label>`, is at least `var(--tap)`
tall, and is what a pointer actually activates.

## The one exemption: calendar day cells at 320px

**A day cell in the month grid is 41.2 × 60.6px at a 320px viewport, against the
44 × 44px this project set itself. This is a deliberate exemption, not an
oversight.**

The arithmetic: a month grid is seven columns. A 320px viewport gives 45.7px per
column *only* with no page gutter at all — no padding on the app body, none on
the calendar panel, and no border. Phase 8 already took the calendar panel's
padding down to `0.15rem` at this width for exactly this reason, which bought
about 3px. The remaining 25px is the app's 12px side gutter, and removing that
would take it from every view to fix one, in the one view that has an
alternative.

The alternative is the reason this is acceptable rather than merely unavoidable:

- **The agenda layout is the equivalent function.** It lists the same
  occurrences from the same `entriesBetween` window, as full-width rows with
  full-width controls. It is one tap from the grid, in a switch that is itself
  now 44px tall.
- Below 520px the grid already stops trying to be the primary layout: cells drop
  their task names, the status dot becomes the whole entry, and the day panel
  below carries the words. The agenda is the recommended layout at this width
  and the design says so.
- The cell is not the only route to anything. Selecting a day filters the panel;
  everything the panel offers is reachable from the agenda and from the task
  list.

This is the shape of WCAG 2.5.5's equivalent-function exception, and it is
recorded here rather than argued from memory later. **If the month grid ever
becomes the only way to reach something, this exemption expires** — the fix
would be to drop the app gutter under 360px, which costs about 24px of breathing
room across every view.

## Keyboard

- Every stop has a visible `:focus-visible` ring — a 2px `--c-foam` outline with
  an offset, on one rule, so it cannot be lost per-component.
- `<dialog>` traps focus while open and returns it to the control that opened
  it. Where that control may no longer exist — the row was completed, the
  project was deleted — each caller names its own ordered fallbacks and
  `restoreFocus` takes the first that actually accepts focus. A `.focus()` on a
  disconnected or inert node silently does nothing and leaves focus on `<body>`,
  which is the end of keyboard navigation until you tab in from the top.
- The calendar separates **focus** from **selection**: arrows move focus and
  announce the day, Enter or Space selects. Exactly one cell is in the tab order
  and the month on show always contains the focused day.
- `Alt+↑` / `Alt+↓` reorders a task without leaving the row, so manual ordering
  is not drag-only.
- `/` focuses quick add; `Ctrl/Cmd+Z` fires the undo bar while it is up.
- Completing the last task in a view is the app's goal state and the case with
  no next row to land on; focus falls back to the view heading, then to quick
  add, rather than to `<body>`.

## Names and colour

- Task rows are `<li>` in a `<ul>` with real `<button>` controls, each named in
  context: **"Complete: Submit finance assignment, due tomorrow"** — not the
  three hundredth identical "Complete".
- Nav links carry their counts in their accessible name, so the number is heard
  rather than skipped as decorative text.
- Nothing is carried by colour alone: priority is a mark (`!`, `!!`, `!!!`) as
  well as an edge colour; today is a filled disc plus `aria-current`; a calendar
  occurrence's three statuses are three *shapes* — filled disc, open ring, flat
  dash — because fill or lightness alone is the colour-alone failure in
  different clothing.
- A calendar cell's `aria-label` is the only thing a screen reader gets from a
  row of dots, so it counts done and skipped separately rather than folding them
  into one "finished".

## Announcements

Completion and undo are announced politely and **coalesced on a 150ms timer**, so
a run of completions is one sentence rather than five interruptions. The live
summary of the surface is a separate region with its own urgency, updated when
its sentence changes.

## How to re-run the audit

```bash
npm run dev
```

Then in the page console, with the viewport at 320px:

```js
const doc = document.documentElement
doc.scrollWidth > innerWidth          // horizontal scroll: must be false
;[...document.querySelectorAll('button, a[href], label.choice, input:not([type=radio]), select')]
  .map((el) => ({ el, r: el.getBoundingClientRect() }))
  .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
```

Run it in each view and with each dialog open. The expected result is empty
everywhere except the calendar day cell documented above.
