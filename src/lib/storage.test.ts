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
