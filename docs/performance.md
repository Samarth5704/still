# Performance — measured

Every number here was taken in a browser on one machine, on 6 September 2026.
None of them is a promise about yours. What is a promise is the last section:
the shader now measures itself and gives back pixels until it fits, so the
budget holds on hardware that could not otherwise meet it.

## The machine

| | |
|---|---|
| CPU / OS | Windows 11, mid-range laptop |
| GPU | Intel UHD Graphics (0x9B41), integrated, via ANGLE / D3D11 |
| Browser | Chrome, WebGL2 with `EXT_disjoint_timer_query_webgl2` |
| Build | `npm run dev` (unminified; the production bundle is smaller and no slower) |

An integrated GPU is the point. This is the machine the budget exists for.

## The shader

Measured with the GPU's own timer queries — not wall clock, which is pinned to
vsync and cannot tell 1ms of work from 16 — at the worst case the shader can be
asked for: `uPressure` 1, `uHeat` 1, all eight ripple slots alive, `uStill` 0.

| Drawing buffer | Megapixels | GPU ms / frame |
|---|---|---|
| 2160 × 1350 (1440×900 at DPR 1.5) | 2.92 | **28.1** |
| 1440 × 900 | 1.30 | 12.3 |
| 1080 × 675 | 0.73 | 7.3 |

That is **9.6 ms per megapixel**, and it scales with pixels almost exactly, which
is what a fragment-bound shader looks like. Stillness and ripples are not the
cost: the same measurement with `uStill` 1 and no ripples came back at 27.3ms.
The cost is the noise field — twelve gradient-noise evaluations per pixel,
through two levels of domain warp.

**So the shader misses the 4ms budget on this machine by seven times, at the
size the spec names.** Nothing about that is visible in a screenshot, which is
exactly why it is written here.

### What was done about it

Two honest options: draw something cheaper, or draw fewer pixels.

Drawing something cheaper means dropping an octave or a warp level, which
changes what the surface *is* — on every machine, including the ones that were
never struggling. Drawing fewer pixels changes nothing about the surface except
its resolution, and the surface is a smooth, low-frequency fluid field that the
compositor upscales for free.

So `gl/renderer.ts` measures its own GPU time and steps the drawing buffer down
through `SCALE_STEPS` (1 → 0.8 → 0.65 → 0.5 → 0.4 → 0.33) until the frame fits
inside `BUDGET_MS`, and back up when there is real headroom. Driven from this
machine's own measured cost, it settles here at:

| | |
|---|---|
| Scale | 0.65 |
| Drawing buffer | 1158 × 731 (from 1781 × 1125) |
| GPU ms / frame | **3.78** |
| Steps taken | two, ~30 frames apart |

The thresholds are asymmetric on purpose — one step up is 1.56× the pixels, so
rising needs the cost to be under 55% of budget rather than merely under it.
Without that gap a surface at 4.1ms would drop a step, measure 2.6ms, rise
again, and oscillate forever, which is far more visible than sitting a step low.
`gl/governor.test.ts` holds the decision table; the two thresholds and the
"never climb on wall clock alone" rule are each a named test.

Where `EXT_disjoint_timer_query_webgl2` does not exist (Safari), there is no cost
signal at all, only the symptom — so the governor steps down on sustained frame
gaps over 20ms and never steps back up on wall clock alone.

## The app, with 200 tasks

`still.store` and `still.render` are exposed on `globalThis` in dev builds only
(`import.meta.env.DEV` in `src/main.ts`); the production bundle does not contain
that block. 200 tasks were added through the store's own `addTask`, each one
triggering a full render.

| | ms |
|---|---|
| Add a task, including the full render pass | **3.80** |
| Full render, Today (48 rows) | 2.84 |
| Full render, Upcoming (112 rows) | 4.54 |
| Full render, All (200 rows) | **6.07** |
| Full render, Calendar (month grid + agenda panel) | 5.56 |

A render pass is everything: pressure, the header, the nav counts, the groups,
the list, and a `sync` into each of the three dialogs. The worst of them is
6.07ms against a 16.7ms frame, and it runs on store changes — a handful a
minute — never per frame. The render loop and the render pass are separate
things and only the loop is per-frame.

At 400 tasks the All view's pass rises to 14.4ms, which is the point at which
the next thing to do would be to stop rendering rows nobody can see. 200 is the
number the budget names and 200 is comfortable.

## Layout and reconciliation

- The render loop reads no layout. `src/perf.test.ts` extracts the bodies of
  `frame`, `draw`, `throttled` and `governResolution` and fails on any of twelve
  layout-forcing APIs appearing in them. The canvas size is pushed in by a
  `ResizeObserver`; the one `getBoundingClientRect` in the renderer is in
  `rippleAtClient`, on the event path, where layout has already happened.
- No view module assigns `innerHTML`, `outerHTML` or calls
  `insertAdjacentHTML` — also held by `src/perf.test.ts`. The list keeps one
  `<li>` per task id and mutates it, so focus, scroll and in-flight animations
  survive a re-render, and a row whose rendered signature has not changed does
  no DOM work at all.
- The calendar makes exactly one `entriesBetween` call per render and shapes the
  grid, the agenda and the day panel out of it. `src/app/calendar.cost.test.ts`
  counts the calls.

## Accessibility, measured at the same time

The full record — what was measured, the three target sizes this phase raised,
and the one exemption with its reasoning — is in
**[accessibility.md](accessibility.md)**. In short: no horizontal scroll at
320px in any view or dialog, every control at 44 x 44px or larger, and a
calendar day cell at 41.2px that is a recorded exemption with the agenda as its
equivalent alternative.

## Reproducing

```bash
npm run dev
```

Then, in the page console: `still.store`, `still.render` and `still.surface`
are the harness. `still.surface.stats` carries `fps`, `frameMs`, `gpuMs` and
`renderScale`. The standalone shader benchmark compiles
`src/gl/surface.frag.glsl` against a full-screen triangle at a chosen drawing
buffer size and times it with `EXT_disjoint_timer_query_webgl2`; the loop is
about forty lines and is the one in the table above.

Contrast is not measured here. It is a build gate:

```bash
npm run contrast
```
