import type { LedgerEvent } from '../schema'
import { confidenceBand } from '../schema'

let seq = 0

/** Builds stored events directly, for pure-fold tests. */
export function ev(kind: LedgerEvent['kind'], payload: Record<string, any>, over: Partial<LedgerEvent> = {}): LedgerEvent {
  seq++
  return {
    schema_version: 1,
    event_id: `e${String(seq).padStart(15, '0')}`,
    seq,
    recorded_at: '2026-10-29T00:00:00.000Z',
    project_id: 'p_0000000000000000',
    run_id: `run-${seq}`,
    change_id: 'c1',
    stage: 'impl',
    phase_id: '1',
    kind,
    operation_key: `k${seq}`,
    producer: 't',
    harness: { version: 't', digest: 'd', install: 'i1', files: {}, params: 'p' },
    payload,
    ...over,
  }
}

export function stage(percent: number, invocations: any[] = [], over: Partial<LedgerEvent> = {}): LedgerEvent {
  return ev('stage_completed', { status: 'completed', confidence: { percent, band: confidenceBand(percent) }, verify: 'passed', invocations }, over)
}

export function inv(backend: string, accepted: number | null, rejected: number | null, status = 'succeeded', skills: string[] = [], role = 'reviewer'): any {
  return { backend, role, skills, status, accepted, rejected, unadjudicated: null }
}

export function outcome(target: LedgerEvent, assessment: 'verify' | 'review', result: string, critical: number | null, over: Partial<LedgerEvent> = {}): LedgerEvent {
  return ev('outcome', { target: { change_id: target.change_id, stage: target.stage, phase_id: target.phase_id }, assessment, result, critical_count: critical, target_event_id: target.event_id }, over)
}

export function decision(options: string[], rec: string | null, initial: string | null, final: string, blind = false, over: Partial<LedgerEvent> = {}): LedgerEvent {
  return ev('human_decision', { decision_id: 'd', topic: 't', options, recommendation: rec, initial_choice: initial, final_choice: final, final_position: options.indexOf(final), blind }, over)
}

export function probe(lessonSide: { verify: string, c: number, w: number }, base: { verify: string, c: number, w: number }, extra: Record<string, any> = {}, over: Partial<LedgerEvent> = {}): LedgerEvent {
  return ev('probe', {
    lesson_id: 'L-0001',
    lesson_scope: 'project',
    mode: 'lesson',
    skip_reason: null,
    candidates: [
      { label: 'A', has_lesson: false, fingerprint: 'f', verify: base.verify, critical_confirmed: base.c, warning_confirmed: base.w, diff_lines: 10 },
      { label: 'B', has_lesson: true, fingerprint: 'f', verify: lessonSide.verify, critical_confirmed: lessonSide.c, warning_confirmed: lessonSide.w, diff_lines: 10 },
    ],
    interdiff_lines: 5,
    ab_map_recorded_after_reviews: true,
    landed: 'A',
    forced: false,
    ...extra,
  }, over)
}
