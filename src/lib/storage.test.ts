import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, defaultState, parseState, serialiseState } from './storage.ts'
import type { State } from './types.ts'

describe('parseState', () => {
  it('falls back to defaults on malformed JSON', () => {
    const result = parseState('{ not json at all')
    expect(result).toMatchObject({ mode: 'read-write', reason: 'malformed' })
    expect(result.state).toEqual(defaultState())
  })

  it('falls back to defaults on JSON that is not an object', () => {
    expect(parseState('[1,2,3]').state).toEqual(defaultState())
    expect(parseState('"hello"').reason).toBe('malformed')
  })

  it('falls back to defaults on empty input', () => {
    expect(parseState(null)).toMatchObject({ mode: 'read-write', reason: 'empty' })
    expect(parseState('')).toMatchObject({ mode: 'read-write', reason: 'empty' })
  })

  it('fails safe into read-only on an unknown future schemaVersion', () => {
    const future = JSON.stringify({
      settings: { ...defaultState().settings, schemaVersion: SCHEMA_VERSION + 1 },
      tasks: [{ id: 'x', title: 'written by a newer build' }],
    })
    const result = parseState(future)
    expect(result.mode).toBe('read-only')
    expect(result.reason).toBe('future-schema')
    // Nothing is carried across, and the caller is told not to write back.
    expect(result.state).toEqual(defaultState())
  })

  it('reads a current-version payload', () => {
    const state: State = {
      ...defaultState(),
      tasks: [
        {
          id: 't1',
          title: 'Submit finance assignment',
          notes: 'the long one',
          done: false,
          completedAt: null,
          due: '2026-09-04',
          dueTime: '17:00',
          priority: 'high',
          projectId: 'p1',
          tagIds: ['tag1'],
          parentId: null,
          order: 3,
          recurrenceId: null,
          createdAt: '2026-09-01T08:00:00.000Z',
        },
      ],
      projects: [{ id: 'p1', name: 'Uni', colorToken: 'teal', icon: 'book', archived: false, order: 0 }],
      tags: [{ id: 'tag1', name: 'admin', colorToken: 'amber', archived: false }],
    }
    const result = parseState(serialiseState(state))
    expect(result.mode).toBe('read-write')
    expect(result.state).toEqual(state)
  })

  it('fills missing fields and drops unknown ones', () => {
    const result = parseState(
      JSON.stringify({
        settings: { theme: 'dark', nonsense: true },
        tasks: [{ id: 't1', title: 'sparse', colour: 'purple' }, { title: 'no id' }, 42],
      }),
    )
    expect(result.state.settings).toEqual({ ...defaultState().settings, theme: 'dark' })
    expect(result.state.tasks).toHaveLength(1)
    expect(result.state.tasks[0]).toMatchObject({ id: 't1', title: 'sparse', priority: 'none', done: false })
    expect(result.state.tasks[0]).not.toHaveProperty('colour')
  })

  it('defaults a stored recurrence with no weekStart to Monday', () => {
    const result = parseState(
      JSON.stringify({
        settings: defaultState().settings,
        recurrences: [
          { id: 'r1', freq: 'weekly', interval: 2, starts: '2026-01-04', byWeekday: [0, 2], ends: { type: 'never' } },
        ],
      }),
    )
    expect(result.state.recurrences[0]).toMatchObject({ weekStart: 1, interval: 2 })
  })

  it('round-trips through serialise', () => {
    const state = defaultState()
    expect(parseState(serialiseState(state)).state).toEqual(state)
  })
})

/*
 * Schema 1 -> 2: `effects` gained `auto` and made it the default.
 *
 * Schema 1 shipped `full` as its default and shipped no way to change it, so
 * every stored `full` from that version is a default nobody picked. Reading it
 * back as a choice would leave those users with an animated background that
 * ignores `prefers-reduced-motion` for good — the migration is the only thing
 * standing between them and that, and the version gate is the only thing that
 * stops it overruling a real choice once an effects control exists.
 */
describe('effects migration', () => {
  const v1 = (effects: string): string =>
    JSON.stringify({ settings: { schemaVersion: 1, effects }, tasks: [] })

  it('turns a schema 1 "full" into "auto", because nobody chose it', () => {
    expect(parseState(v1('full')).state.settings.effects).toBe('auto')
  })

  it.each(['reduced', 'off'])('leaves a schema 1 "%s" alone', (effects) => {
    // These could only have been set by hand; there was no UI for any of it.
    expect(parseState(v1(effects)).state.settings.effects).toBe(effects)
  })

  it('treats a settings block with no version at all as schema 1', () => {
    // The field has existed for as long as the format has, so its absence means
    // "written before this build cared", not "written by this build".
    const raw = JSON.stringify({ settings: { effects: 'full' }, tasks: [] })
    expect(parseState(raw).state.settings.effects).toBe('auto')
  })

  it('stops migrating at schema 2, so a real choice survives', () => {
    const v2 = JSON.stringify({ settings: { schemaVersion: 2, effects: 'full' }, tasks: [] })
    expect(parseState(v2).state.settings.effects).toBe('full')
  })

  it('defaults to auto, and accepts auto back', () => {
    expect(defaultState().settings.effects).toBe('auto')
    expect(parseState(v1('auto')).state.settings.effects).toBe('auto')
  })

  it('falls back to auto on a value from nowhere', () => {
    expect(parseState(v1('sparkles')).state.settings.effects).toBe('auto')
  })

  it('stamps the current version on the way out', () => {
    const parsed = parseState(v1('full')).state
    expect(parsed.settings.schemaVersion).toBe(SCHEMA_VERSION)
    expect(JSON.parse(serialiseState(parsed)).settings.schemaVersion).toBe(SCHEMA_VERSION)
  })
})
