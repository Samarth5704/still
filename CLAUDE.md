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
- Pressure saturates (1 - exp(-load/k)), never scales linearly.

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
