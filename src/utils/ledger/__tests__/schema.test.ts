import { describe, expect, it } from 'vitest'
import { isStoredEvent, ValidationError, validateInput } from '../schema'
import { decisionEvent, probeEvent, stageEvent } from './fixtures'

function rejects(event: unknown, match: RegExp): void {
  expect(() => validateInput(event)).toThrow(ValidationError)
  expect(() => validateInput(event)).toThrow(match)
}

describe('validateInput', () => {
  it('accepts the five kinds', () => {
    expect(() => validateInput(stageEvent())).not.toThrow()
    expect(() => validateInput(decisionEvent())).not.toThrow()
    expect(() => validateInput(probeEvent())).not.toThrow()
    expect(() => validateInput({ ...stageEvent(), kind: 'outcome', payload: { target: { change_id: 'c1', stage: 'review', phase_id: null }, assessment: 'review', result: 'passed', critical_count: 0 } })).not.toThrow()
    expect(() => validateInput({
      ...stageEvent(),
      stage: 'lesson',
      kind: 'lesson_state',
      payload: { lesson_id: 'L-0001', scope: 'project', from: null, to: 'candidate', reason: 'added', tally: { W: 0, L: 0, T: 0, inert: 0, void: 0, changes_with_wins: 0, severe_losses: 0 } },
    })).not.toThrow()
  })

  it('rejects unknown fields at any depth', () => {
    rejects({ ...stageEvent(), extra: 1 }, /event\.extra: unknown field/)
    const e = stageEvent()
    e.payload.invocations[0].note = 'x'
    rejects(e, /invocations\[0\]\.note: unknown field/)
  })

  it('rejects fields the CLI assigns', () => {
    for (const key of ['event_id', 'seq', 'recorded_at', 'project_id', 'producer', 'harness']) {
      rejects({ ...stageEvent(), [key]: 'x' }, new RegExp(`event\\.${key}: unknown field`))
    }
    rejects({ ...stageEvent(), kind: 'outcome', payload: { target: { change_id: 'c1', stage: 'review', phase_id: null }, assessment: 'review', result: 'passed', critical_count: 0, target_event_id: 'x' } }, /assigned by the CLI/)
  })

  it('derives the confidence band and rejects a wrong one', () => {
    const e = validateInput(stageEvent())
    expect(e.payload.confidence.band).toBe('Medium')
    const wrong = stageEvent()
    wrong.payload.confidence.band = 'High'
    rejects(wrong, /band: must be Medium/)
    const high = stageEvent()
    high.payload.confidence.percent = 96
    rejects(high, /percent: expected integer 0..95/)
  })

  it('requires choices to be among the options', () => {
    const e = decisionEvent()
    e.payload.final_choice = 'elsewhere'
    rejects(e, /final_choice: must be one of options/)
    const r = decisionEvent()
    r.payload.final_position = 2
    rejects(r, /final_position/)
  })

  it('preserves null observations', () => {
    const e = validateInput(decisionEvent())
    expect(e.payload.initial_choice).toBeNull()
    expect(validateInput(stageEvent()).payload.invocations[0].unadjudicated).toBeNull()
  })

  it('enforces text and array limits', () => {
    const topic = decisionEvent()
    topic.payload.topic = 'x'.repeat(201)
    rejects(topic, /topic: longer than 200/)
    const many = stageEvent()
    many.payload.invocations = Array.from({ length: 101 }, () => many.payload.invocations[0])
    rejects(many, /expected 0..100 items/)
  })

  it('rejects absolute paths and requires phase_id for impl stage events', () => {
    const e = decisionEvent()
    e.payload.topic = 'edit /home/alice/repo/src/a.ts'
    rejects(e, /absolute path/)
    const ok = decisionEvent()
    ok.payload.topic = 'run /osm:impl on src/a.ts'
    expect(() => validateInput(ok)).not.toThrow()
    rejects(stageEvent({ stage: 'impl' }), /phase_id: required/)
  })

  it('checks probe shape', () => {
    const both = probeEvent()
    both.payload.candidates[0].has_lesson = true
    rejects(both, /exactly one candidate must have the lesson/)
    const skipped = probeEvent()
    skipped.payload = { ...skipped.payload, skip_reason: 'dirty-base', candidates: [], interdiff_lines: null, ab_map_recorded_after_reviews: null, landed: null }
    expect(() => validateInput(skipped)).not.toThrow()
    const half = probeEvent()
    half.payload.skip_reason = 'budget'
    rejects(half, /must be \[\] when skipped/)
  })
})

describe('review fixes', () => {
  it('rejects machine paths in every common form and allows route-like text', () => {
    const bad = [
      'see `/root/OpenSlime/src/x.ts`',
      'failed at:/home/han/repo',
      'path,/home/han/x',
      '[/etc/passwd]',
      'C:/Users/han.feng/repo',
      'C:\\Users\\x',
      '\\\\server\\share\\x',
      'file:///home/alice/x',
      '/Users/bob',
      'see /c/Users/alice/repo',
      'see /C/Users/alice',
      '/data/alice/x',
    ]
    for (const topic of bad) {
      const e = decisionEvent()
      e.payload.topic = topic
      rejects(e, /absolute path/)
    }
    for (const topic of ['Should we expose /api/v1?', 'run /osm:impl on src/a.ts', '~/.claude/osm-ledger', '/homepage redesign', 'see https://example.com/a/b', 'Should /data endpoint paginate?', 'rename /run route', 'opt in via /opt-in', 'GET /data', 'post it to /r/home', 'see /v/var', 'GET /users/123', 'list /volumes']) {
      const e = decisionEvent()
      e.payload.topic = topic
      expect(() => validateInput(e)).not.toThrow()
    }
  })

  it('rejects control characters in ids, so NUL cannot forge an event id', () => {
    rejects(decisionEvent({ run_id: 'A\u0000probe' }), /control characters/)
    rejects(decisionEvent({ operation_key: 'k\n' }), /control characters/)
  })

  it('requires final_position to match final_choice in the displayed order', () => {
    const e = decisionEvent()
    e.payload.final_choice = 'repo'
    e.payload.final_position = 0
    rejects(e, /index of final_choice/)
    e.payload.final_position = 1
    expect(() => validateInput(e)).not.toThrow()
  })

  it('requires lesson_id for a lesson probe, skipped or not', () => {
    const e = probeEvent()
    e.payload.lesson_id = null
    e.payload.lesson_scope = null
    rejects(e, /lesson_id: required for a lesson probe/)
    const explore = probeEvent()
    explore.payload = { ...explore.payload, mode: 'explore', lesson_id: null, lesson_scope: null }
    expect(() => validateInput(explore)).not.toThrow()
    explore.payload.lesson_id = 'L-0001'
    explore.payload.lesson_scope = 'project'
    rejects(explore, /must be null for an explore probe/)
  })
})

describe('isStoredEvent', () => {
  const stored = (payload: any, kind = 'human_decision') => ({ ...decisionEvent(), kind, payload, event_id: 'e1', seq: 1, recorded_at: '2026-10-29T00:00:00.000Z', project_id: 'p_0000000000000000', producer: 't', harness: { version: 't', digest: 'd', install: 'i', files: {}, params: 'p' } })

  it('checks shape but not append-time caps, so a lowered cap never invalidates history', () => {
    const options = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(isStoredEvent(stored({ ...decisionEvent().payload, options, recommendation: 'a', final_choice: 'a', final_position: 0, topic: 'x'.repeat(500) }))).toBe(true)
    expect(isStoredEvent(stored({ ...decisionEvent().payload, final_choice: 'zzz' }))).toBe(false)
    expect(isStoredEvent({ event_id: 'x', seq: 9, kind: 'stage_completed' })).toBe(false)
    expect(isStoredEvent(stored({ ...decisionEvent().payload, options: ['user'], final_choice: 'user', final_position: 0 }))).toBe(false)
    const p = probeEvent().payload
    expect(isStoredEvent(stored({ ...p, candidates: [...p.candidates, p.candidates[0]] }, 'probe'))).toBe(false)
    const badFiles = stored(decisionEvent().payload)
    badFiles.harness = { ...badFiles.harness, files: 'ab' as any }
    expect(isStoredEvent(badFiles)).toBe(false)
    expect(() => validateInput({ ...decisionEvent(), payload: { ...decisionEvent().payload, topic: 'x'.repeat(500) } })).toThrow(/longer than 200/)
  })
})
