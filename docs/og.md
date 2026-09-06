# Capturing the images

Every image committed in this repo is a capture of the app or the surface at a
named state. None of them is retouched and none came from another tool, so any
of them can be regenerated from the recipe below when the design moves.

## The OG image

`public/og.jpg` — 1200 × 630, the link preview.

It is a frame of **this project's own shader**, not a wordmark and not a
composite. A todo app whose entire idea is that the background reports your
backlog should preview as that background; a generated logo would preview as a
logo, which is the one thing this app does not lead with.

```bash
npm run dev
```

```bash
chrome --headless=new \
  --user-data-dir=/tmp/still-og --hide-scrollbars \
  --screenshot=public/og.png --window-size=1200,630 \
  "http://localhost:5173/shader.html?capture&pressure=0.35&heat=0&time=6"
```

Then re-encode — a 1200 × 630 PNG of this surface is about 630KB and the same
image as a quality-88 progressive JPEG is about 70KB, which matters for a file
whose entire job is to load inside someone else's preview card:

```bash
python -c "from PIL import Image; Image.open('public/og.png').convert('RGB').save('public/og.jpg', quality=88, optimize=True, progressive=True)"
rm public/og.png
```

### Why those parameters

| | | |
|---|---|---|
| `pressure` | 0.35 | Enough frequency and relief for the surface to read as liquid rather than as a gradient, well short of the agitation of a bad week. The preview should look like the state the app is trying to get you to. |
| `heat` | 0 | The cool ramp is the product's own colour. Any heat at all walks toward dusk, and around 0.2 the palette is a desaturated navy — correct behaviour, poor thumbnail. |
| `time` | 6 | Nothing special: six seconds in, the field has folded away from its starting configuration. Any fixed value works; a fixed one is the point. |

## Capture mode

`/shader.html?capture` is a real feature of the lab, not a flag for this file:

- `pressure`, `heat` and `still` seed the **actual sliders** and dispatch their
  `input` events, so capture mode cannot drift away from what the panel does.
  Drop `capture` from the same URL and you get the panel with those exact
  values loaded, which is how a "look at this state" link is shared.
- `time` calls `Surface.seek()` and pins `timeScale` to 0. The surface is a
  pure function of time and the two channels, so this is what makes a frame
  reproducible rather than approximately reproducible.
- `capture` hides the panel and creates the WebGL context with
  `preserveDrawingBuffer: true`. The app never does that — it costs a copy per
  frame for something nothing reads — but a screenshot re-composites the canvas
  *after* the frame has been presented, and without the buffer it re-composites
  nothing.
- Capture mode also draws one frame synchronously via `Surface.renderNow()`
  before starting the loop, because the loop's first frame is an animation
  callback away and a screenshot taken before it captures the page background
  with no error of any kind.

The loop is deliberately left running. Stopping it after a frame or two looks
tidier and quietly breaks the capture: the canvas is sized from a
`ResizeObserver` whose first callback can land after those frames, so the loop
dies at the default 300 × 150 with nothing drawn in it.

### What this found

The first four captures came back **byte-for-byte identical** at four different
pressure and heat settings. The cause was not in any of the machinery above:
`lab.css` styles `.still-fallback` with `position: fixed; inset: 0;
display: block`, and that `display` outranks the user-agent
`[hidden] { display: none }` rule — so the fallback div had been sitting over
the canvas since Phase 2, painted with its default cool ramp. The lab looked
plausible for six phases because a calm blue wash is a thing this surface does.
The sliders had simply never moved the background.

`src/style.test.ts` holds exactly this rule for `src/style.css` and is the
reason the app never had the bug. It does not read `lab.css`.

## The README screenshots

`docs/screenshots/*.png` — 1440 × 900, captured from the real app with a
seeded store.

The store is seeded through its own `addTask`, from a throwaway `seed.html` at
the project root that imports `/src/app/store.ts` and `/src/lib/parse.ts`
directly under `vite dev`. It is written for the capture and deleted afterwards
rather than committed: a page that writes to the app's own `localStorage` key
has no business being in the build, and the deploy allowlist would fail on it
if it ever reached `dist/`.

The two-pass shape matters — headless Chrome runs no script of your choosing,
so the seeding has to be a page visit, and the profile has to persist between
the two runs for `localStorage` to carry over:

```bash
chrome --headless=new --user-data-dir=/tmp/still-shots \
  --virtual-time-budget=5000 --screenshot=/tmp/_seed.png --window-size=800,600 \
  "http://localhost:5173/seed.html?theme=dark&mode=late"

chrome --headless=new --user-data-dir=/tmp/still-shots --hide-scrollbars \
  --screenshot=docs/screenshots/overdue.png --window-size=1440,900 \
  "http://localhost:5173/#/today"
```

| File | Seed | View |
|---|---|---|
| `today.png` | `theme=dark&mode=calm` | `#/today` |
| `calendar.png` | `theme=dark&mode=calm` | `#/calendar` |
| `overdue.png` | `theme=dark&mode=late` | `#/today` |
| `light.png` | `theme=light&mode=calm` | `#/all` |

The theme comes from the seeded setting rather than from a Chrome flag, which
is both more direct and a live test of the preference: `light.png` is the
`[data-theme='light']` path, not the `prefers-color-scheme` one.

Two notes for whoever regenerates these:

- **Do not use `--virtual-time-budget` on the app.** Its render loop never
  settles, so virtual time never drains and the screenshot never fires. It is
  fine on `seed.html`, which finishes.
- The dates in `mode=late` are explicit offsets, not quick-add phrases. The
  parser has no "9 days ago" and should not: nothing about a todo app wants a
  grammar for scheduling things in the past.
