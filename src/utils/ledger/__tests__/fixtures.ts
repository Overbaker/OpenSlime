import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'

export function tmp(prefix = 'osm-ledger-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Deterministic PRNG so generated cases are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleKeys(value: unknown, rand: () => number): unknown {
  if (Array.isArray(value)) return value.map(v => shuffleKeys(v, rand))
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[keys[i], keys[j]] = [keys[j], keys[i]]
    }
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = shuffleKeys((value as Record<string, unknown>)[k], rand)
    return out
  }
  return value
}

export function stageEvent(over: Record<string, unknown> = {}): any {
  return {
    schema_version: 1,
    run_id: 'run-1',
    change_id: 'c1',
    stage: 'review',
    phase_id: null,
    kind: 'stage_completed',
    operation_key: 'report',
    payload: {
      status: 'completed',
      confidence: { percent: 75 },
      verify: 'passed',
      invocations: [
        { backend: 'codex', role: 'reviewer', skills: [], status: 'succeeded', accepted: 3, rejected: 1, unadjudicated: null },
      ],
    },
    ...over,
  }
}

export function decisionEvent(over: Record<string, unknown> = {}): any {
  return {
    schema_version: 1,
    run_id: 'run-1',
    change_id: 'c1',
    stage: 'plan',
    phase_id: null,
    kind: 'human_decision',
    operation_key: 'q1',
    payload: {
      decision_id: 'q1',
      topic: 'Where does the ledger live?',
      options: ['user', 'repo'],
      recommendation: 'user',
      initial_choice: null,
      final_choice: 'user',
      final_position: 0,
      blind: false,
    },
    ...over,
  }
}

export function probeEvent(over: Record<string, unknown> = {}): any {
  return {
    schema_version: 1,
    run_id: 'run-2',
    change_id: 'c1',
    stage: 'impl',
    phase_id: '1',
    kind: 'probe',
    operation_key: 'probe-1.1',
    payload: {
      lesson_id: 'L-0001',
      lesson_scope: 'project',
      mode: 'lesson',
      skip_reason: null,
      candidates: [
        { label: 'A', has_lesson: false, fingerprint: 'f1', verify: 'passed', critical_confirmed: 1, warning_confirmed: 0, diff_lines: 40 },
        { label: 'B', has_lesson: true, fingerprint: 'f1', verify: 'passed', critical_confirmed: 0, warning_confirmed: 0, diff_lines: 55 },
      ],
      interdiff_lines: 16,
      ab_map_recorded_after_reviews: true,
      landed: 'B',
      forced: false,
    },
    ...over,
  }
}
