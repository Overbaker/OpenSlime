import { describe, expect, it } from 'vitest'
import { CHANGE_KINDS, DIMENSIONS, isStoredEvent, ValidationError, validateInput } from '../schema'
import { summarize } from '../summary'
import { decision, inv, outcome, probe, stage } from './events'
import { decisionEvent, mulberry32, probeEvent, shuffleKeys, stageEvent } from './fixtures'

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

describe('ledger dimensions: optional v1 fields', () => {
  const full = () => {
    const e = stageEvent()
    Object.assign(e.payload.invocations[0], { model: 'claude-opus-5-5', mcp_tools: ['context7:query-docs'], practices: ['tdd', 'pbt'], cost: { tokens: 1200, usd: 0.012345 } })
    Object.assign(e.payload, { ai_decisions: { design: 2, skill: 0 }, change_kind: 'feature' })
    return e
  }

  it('accepts every new field, and null as not reported', () => {
    expect(() => validateInput(full())).not.toThrow()
    expect(() => validateInput(decisionEvent({ payload: { ...decisionEvent().payload, dimension: 'design', position: 'run-hash-v1' } }))).not.toThrow()
    expect(() => validateInput(probeEvent({ payload: { ...probeEvent().payload, writer: { backend: 'codex', role: 'builder', model: null }, change_kind: 'fix' } }))).not.toThrow()
    const nulls = stageEvent()
    Object.assign(nulls.payload.invocations[0], { model: null, mcp_tools: null, practices: null, cost: null })
    Object.assign(nulls.payload, { ai_decisions: null, change_kind: null })
    expect(() => validateInput(nulls)).not.toThrow()
    expect(() => validateInput(decisionEvent({ payload: { ...decisionEvent().payload, dimension: null, position: null } }))).not.toThrow()
    expect(() => validateInput(probeEvent({ payload: { ...probeEvent().payload, writer: null, change_kind: null } }))).not.toThrow()
  })

  it('normalizes mcp__server__tool to server:tool and keeps names unique', () => {
    const e = full()
    e.payload.invocations[0].mcp_tools = ['mcp__context7__query-docs', 'github:search_code']
    expect(validateInput(e).payload.invocations[0].mcp_tools).toEqual(['context7:query-docs', 'github:search_code'])
    e.payload.invocations[0].mcp_tools = ['mcp__context7__query-docs', 'context7:query-docs']
    rejects(e, /mcp_tools: must be unique/)
    for (const bad of ['context7', 'a:b:c', ':tool', 'srv:', 'sp ace:t', `${'s'.repeat(65)}:t`, 'mcp__x', 7]) {
      e.payload.invocations[0].mcp_tools = [bad]
      rejects(e, /expected <server>:<tool>|expected string/)
    }
    e.payload.invocations[0].mcp_tools = Array.from({ length: 21 }, (_, i) => `s:t${i}`)
    rejects(e, /mcp_tools: expected 0..20 items/)
  })

  it('enforces model, practices and cost caps', () => {
    const cases: Array<[(e: any) => void, RegExp]> = [
      [e => { e.payload.invocations[0].model = 'm'.repeat(65) }, /model: longer than 64/],
      [e => { e.payload.invocations[0].model = '' }, /model: must not be empty/],
      [e => { e.payload.invocations[0].practices = Array.from({ length: 11 }, (_, i) => `p${i}`) }, /practices: expected 0..10 items/],
      [e => { e.payload.invocations[0].practices = ['tdd', 'tdd'] }, /practices: must be unique/],
      [e => { e.payload.invocations[0].practices = ['p'.repeat(41)] }, /longer than 40/],
      [e => { e.payload.invocations[0].practices = ['Plan First'] }, /lowercase slug/],
      [e => { e.payload.invocations[0].cost = {} }, /expected tokens and\/or usd/],
      [e => { e.payload.invocations[0].cost = { tokens: 1e10 + 1, usd: null } }, /tokens: expected integer/],
      [e => { e.payload.invocations[0].cost = { tokens: 1.5, usd: null } }, /tokens: expected integer/],
      [e => { e.payload.invocations[0].cost = { tokens: null, usd: 10000.5 } }, /usd: expected number/],
      [e => { e.payload.invocations[0].cost = { tokens: null, usd: -1 } }, /usd: expected number/],
      [e => { e.payload.invocations[0].cost = { tokens: null, usd: 0.1234567 } }, /at most 6 decimals/],
      [e => { e.payload.invocations[0].cost = { tokens: null, usd: 1, eur: 1 } }, /cost\.eur: unknown field/],
      [e => { e.payload.ai_decisions = { design: 1001 } }, /ai_decisions\.design: expected integer 0..1000/],
      [e => { e.payload.ai_decisions = { design: null } }, /ai_decisions\.design: expected integer/],
      [e => { e.payload.ai_decisions = [] }, /ai_decisions: expected object/],
    ]
    for (const [mutate, match] of cases) {
      const e = full()
      mutate(e)
      rejects(e, match)
    }
    const edge = full()
    edge.payload.invocations[0].cost = { tokens: 1e10, usd: 1e4 }
    expect(() => validateInput(edge)).not.toThrow()
    edge.payload.invocations[0].cost = { tokens: 0, usd: 0.000001 }
    expect(() => validateInput(edge)).not.toThrow()
  })

  it('Q6: unknown dimension, ai_decisions key, change_kind or position exits 2 and lists the allowed values', () => {
    rejects(decisionEvent({ payload: { ...decisionEvent().payload, dimension: 'budget' } }), new RegExp(`dimension: expected one of ${DIMENSIONS.join('\\|')}`))
    const rand = mulberry32(13)
    const word = () => Array.from({ length: 1 + Math.floor(rand() * 10) }, () => 'abcdefghijklmnopqrstuvwxyz-_'[Math.floor(rand() * 28)]).join('')
    for (let i = 0; i < 100; i++) {
      const w = word()
      if (!(DIMENSIONS as readonly string[]).includes(w)) {
        rejects(decisionEvent({ payload: { ...decisionEvent().payload, dimension: w } }), /dimension: expected one of/)
        const s = stageEvent()
        s.payload.ai_decisions = { [w]: 1 }
        rejects(s, /ai_decisions\..*: expected one of/)
      }
      if (!(CHANGE_KINDS as readonly string[]).includes(w)) {
        rejects(stageEvent({ payload: { ...stageEvent().payload, change_kind: w } }), /change_kind: expected one of/)
        rejects(probeEvent({ payload: { ...probeEvent().payload, change_kind: w } }), /change_kind: expected one of/)
      }
      if (w !== 'run-hash-v1') rejects(decisionEvent({ payload: { ...decisionEvent().payload, position: w } }), /position: expected one of run-hash-v1/)
    }
    for (const bad of [1, true, ['design'], {}]) rejects(decisionEvent({ payload: { ...decisionEvent().payload, dimension: bad } }), /dimension: expected one of/)
  })

  it('checks the probe writer shape', () => {
    const e = probeEvent()
    e.payload.writer = { backend: 'codex', role: 'builder' }
    rejects(e, /writer\.model: missing field/)
    e.payload.writer = { backend: 'Codex', role: 'builder', model: null }
    rejects(e, /writer\.backend: expected lowercase slug/)
    e.payload.writer = { backend: 'codex', role: 'builder', model: 'm'.repeat(65) }
    rejects(e, /writer\.model: longer than 64/)
    e.payload.writer = { backend: 'codex', role: 'builder', model: 'gpt-5' }
    expect(() => validateInput(e)).not.toThrow()
  })

  it('rejects a caller-supplied context', () => {
    rejects({ ...stageEvent(), context: { v: 1 } }, /event\.context: assigned by the CLI/)
    rejects({ ...stageEvent(), context: null }, /event\.context: assigned by the CLI/)
  })

  it('isStoredEvent accepts the new fields and a stored context with the shape-only check', () => {
    const envelope = { event_id: 'e1', seq: 1, recorded_at: '2026-10-29T00:00:00.000Z', project_id: 'p_0000000000000000', producer: 't', harness: { version: 't', digest: 'd', install: 'i', files: {}, params: 'p' } }
    const e = { ...full(), ...envelope, context: { v: 1, digest: '0123456789abcdef' } }
    expect(isStoredEvent(e)).toBe(true)
    e.payload.invocations[0].practices = Array.from({ length: 11 }, (_, i) => `p${i}`)
    expect(isStoredEvent(e)).toBe(true)
    expect(isStoredEvent({ ...e, context: 'x' })).toBe(false)
    expect(isStoredEvent({ ...e, payload: { ...e.payload, change_kind: 'budget' } })).toBe(false)
    expect(isStoredEvent({ ...decisionEvent({ payload: { ...decisionEvent().payload, dimension: 'design', position: 'run-hash-v1' } }), ...envelope })).toBe(true)
  })

  it('Q1: every pre-change event still validates and folds to the same totals', () => {
    const rand = mulberry32(21)
    const events = []
    for (let i = 0; i < 200; i++) {
      const pick = Math.floor(rand() * 4)
      const s = stage(Math.floor(rand() * 96), [inv(['codex', 'gemini'][i % 2], Math.floor(rand() * 4), Math.floor(rand() * 3), rand() < 0.1 ? 'failed' : 'succeeded', rand() < 0.5 ? ['tdd-skill'] : [])])
      if (pick === 0) events.push(s)
      else if (pick === 1) events.push(s, outcome(s, rand() < 0.5 ? 'verify' : 'review', rand() < 0.7 ? 'passed' : 'failed', Math.floor(rand() * 2)))
      else if (pick === 2) events.push(decision(['a', 'b', 'c'], rand() < 0.8 ? 'a' : null, null, ['a', 'b', 'c'][Math.floor(rand() * 3)], rand() < 0.2))
      else events.push(probe({ verify: 'passed', c: 0, w: Math.floor(rand() * 3) }, { verify: 'passed', c: Math.floor(rand() * 2), w: 1 }))
    }
    for (const e of events) {
      expect(isStoredEvent(shuffleKeys(e, rand))).toBe(true)
      const { event_id, seq, recorded_at, project_id, producer, harness, ...input } = e
      const { target_event_id, ...payload } = input.payload
      expect(() => validateInput(structuredClone({ ...input, payload }))).not.toThrow()
    }
    const before = JSON.stringify(summarize(events))
    const withNulls = events.map((e) => {
      const c = structuredClone(e)
      if (c.kind === 'stage_completed') {
        Object.assign(c.payload, { ai_decisions: null, change_kind: null })
        for (const i of c.payload.invocations) Object.assign(i, { model: null, mcp_tools: null, practices: null, cost: null })
      }
      if (c.kind === 'human_decision') Object.assign(c.payload, { dimension: null, position: null })
      if (c.kind === 'probe') Object.assign(c.payload, { writer: null, change_kind: null })
      return { ...c, context: { v: 1 } }
    })
    expect(withNulls.every(isStoredEvent)).toBe(true)
    expect(JSON.stringify(summarize(withNulls))).toBe(before)
  })
})
