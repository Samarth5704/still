# Still — project invariants

The full spec is in docs/still-prompt.md. Read it before starting any phase.

## Stack — hard constraints
- Vite + TypeScript, strict mode. Raw WebGL2 with hand-written GLSL.
- NO three.js, react-three-fiber, ShaderGradient, p5, or any shader library.
- NO UI framework, CSS framework, component library, animation library,
  date library, or state library.
- Icons and the shader are written from scratch in this repo.
- Vitest for tests. Google Fonts link is the only permitted runtime resource.

## Architecture invariants
- lib/ is pure: no DOM access, no clock reads, no globals. Every function
  takes its inputs explicitly, including "today".
- Dates are 'YYYY-MM-DD' strings in state, never Date objects. Date appears
  only inside lib/dates.ts.
- Recurring tasks store a RULE, never materialised instances. Every generator
  takes an explicit window and a hard cap. A never-ending rule must never
  produce an unbounded array.
- Completing a recurring task completes ONE occurrence via an exception
  record. It never mutates the rule.
- Subtasks are one level deep, not a tree. A task with a parentId cannot have
  children. Enforced in the store.
- SUBTASK_STRIPPED in lib/tasks.ts is the single definition of what a subtask
  cannot carry. Subtasks are checklist items, not indented tasks: they have a
  title and a tick and nothing else, and that is the whole reason this stays
  one level deep rather than becoming a tree. The moment a subtask can hold its
  own date, project or rule, it is a task, and users will reasonably expect to
  nest one under it.
  ANY NEW FIELD ON Task MUST BE CLASSIFIED THERE — stripped or inherited — in
  the same commit that adds it. A field that is neither is silently inherited,
  which is the wrong default and fails without an error. recurrenceId is
  stripped, and anything alongside it must be too, because an occurrence of a
  checklist item is meaningless. Phase 5 added no Task field: the scope of an
  edit is per-visit state in app/detail.ts and never reaches the data.
  lib/tasks.ts enforces this on creation; app/detail.ts hides the matching
  regions for a subtask. Both sides read from the one constant, so they cannot
  drift.
- Pressure saturates (1 - exp(-load/k)), never scales linearly.

### Recurrence in the app (lib/series.ts)
- The TASK IS THE SERIES: one Task per rule, and its `due` is the occurrence it
  currently sits on. Ticking records a 'completed' exception and walks `due`
  forward; exhausting the rule is the only thing that sets `done`.
- store.setDone routes a repeating task to completeOccurrence. There is one way
  to tick a task and it always does the right thing — do not add a second.
  Advancing also unticks the subtasks: the checklist belongs to the occurrence.
- A skip consumes one of an ends.after count, so the UI shows a POSITION
  ("3 of 10 scheduled") and never a remainder ("7 left"), which a skip would
  silently falsify. totalOccurrences refuses to count past 1000 rather than
  generate a series to answer a cosmetic question.
- "This and all future" splits the rule: the original ends the day before, the
  new one starts on the day. An ends.after the user did not touch carries
  across as REMAINING, not restated. The truncated original is kept only when
  it carries exceptions — a husk no task points at can never be rendered.
- Every "what comes next" search is still a bounded window over the bounded
  generator. lib/series.ts never calls occurrencesBetween without one.
- app/recurrence.ts is the ONE dialog with a genuine Cancel, because a
  half-built rule must never reach the store. It holds a draft, resolves a
  promise, and says so in its footer. Everything else still saves as you go.
- The scope question is asked once per visit to the detail dialog, on the first
  edit, and the answer is then shown with a way to change it.

### Quick-add parsing (lib/parse.ts)
- Token KINDS claim characters in a fixed order (KIND_ORDER): recurrence, then
  time, then date, then priority, project, tag. That is what makes
  "every monday" a rule rather than a due date, and keeps "at 5pm" from having
  its digits eaten by "in 3 days".
- WITHIN a kind, matchers resolve by POSITION IN THE INPUT — the earliest match
  wins — never by their order in the MATCHERS table. Table order is only a
  tie-break for two matches starting at the same character, arranged
  specific-before-general. Resolving by table order instead means the second
  thing the user typed silently beats the first: "every monday every 3 days"
  becomes a daily rule, "monday tomorrow" is due tomorrow.
- A recurrence that NAMES its own anchor ("every monday", "every last friday")
  sets recurrenceAnchored and is never re-anchored by a date found later in the
  line. Only an implied rule ("every week", "every 2 months") takes its day
  from the due date. A new matcher that produces byWeekday or byNthWeekday MUST
  set this flag.
- Both rules above regress silently. Any new matcher must be added to
  ANCHORED_PHRASES or IMPLIED_PHRASES in parse.test.ts, and to the PAIRS list
  if it can compete with an existing matcher of the same kind.
- The render loop touches no DOM and reads no layout.
- Never re-render a list with innerHTML. Reconcile keyed nodes.
- Text NEVER sits directly on the shader. Every text-bearing surface has a
  scrim with a guaranteed minimum opacity beneath it.
- The shader carries information, so it always has a text equivalent.
- Reduced-effects mode removes motion, never information. uStill damps flow and
  warp; frequency, relief and palette still follow pressure and heat, and the
  CSS fallback encodes both too.
- WebGL context loss must be handled: preventDefault on lost, rebuild on
  restored.
