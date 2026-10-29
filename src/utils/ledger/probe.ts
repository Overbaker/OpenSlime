import type { ProbeCandidate } from './schema'
import { PARAMS } from './params'

export type ProbeResult = 'skipped' | 'confounded' | 'void' | 'inert' | 'win' | 'loss' | 'severe_loss' | 'tie'

export interface ProbePayload {
  lesson_id: string | null
  mode: 'lesson' | 'explore'
  skip_reason: string | null
  candidates: ProbeCandidate[]
  interdiff_lines: number | null
}

/** True for results that count toward a lesson's tally. */
export function isCredited(result: ProbeResult): boolean {
  return result === 'win' || result === 'loss' || result === 'severe_loss' || result === 'tie'
}

/** Losses a result counts for; a severe loss counts double. */
export function lossWeight(result: ProbeResult): number {
  return result === 'severe_loss' ? PARAMS.probe.severeLossWeight : result === 'loss' ? 1 : 0
}

/**
 * The probe outcome from the lesson side's point of view. Diff size never decides it.
 * Order: confounded > void > inert > VERIFY (severe loss) > confirmed Criticals > confirmed Warnings > tie.
 */
export function probeResult(p: ProbePayload): ProbeResult {
  if (p.skip_reason !== null) return 'skipped'
  if (p.mode === 'explore') return 'confounded'
  const [a, b] = p.candidates
  if (a.fingerprint !== b.fingerprint) return 'confounded'
  if (a.verify === 'error' || b.verify === 'error') return 'void'
  if (p.interdiff_lines === 0) return 'inert'
  const lesson = a.has_lesson ? a : b
  const base = a.has_lesson ? b : a
  if (lesson.verify !== base.verify) return lesson.verify === 'passed' ? 'win' : 'severe_loss'
  if (lesson.critical_confirmed !== base.critical_confirmed) return lesson.critical_confirmed < base.critical_confirmed ? 'win' : 'loss'
  if (lesson.warning_confirmed !== base.warning_confirmed) return lesson.warning_confirmed < base.warning_confirmed ? 'win' : 'loss'
  return 'tie'
}

export interface Tally {
  W: number
  L: number
  T: number
  inert: number
  void: number
  changes_with_wins: number
  severe_losses: number
  decisive: number
  total: number
}

interface ProbeEventLike {
  kind: string
  seq: number
  change_id: string | null
  payload: Record<string, any>
}

/** The tally of one lesson from lesson-mode, non-skipped probe events (losses weighted; severe counts double). */
export function lessonTally(events: ProbeEventLike[], scope: string, lessonId: string): Tally {
  const t: Tally = { W: 0, L: 0, T: 0, inert: 0, void: 0, changes_with_wins: 0, severe_losses: 0, decisive: 0, total: 0 }
  const changes = new Set<string>()
  for (const e of events) {
    if (e.kind !== 'probe' || e.payload.mode !== 'lesson' || e.payload.lesson_id !== lessonId || e.payload.lesson_scope !== scope) continue
    const r = probeResult(e.payload as ProbePayload)
    if (r === 'skipped') continue
    t.total++
    if (r === 'win') {
      t.W++
      t.decisive++
      if (e.change_id) changes.add(e.change_id)
    }
    else if (r === 'loss' || r === 'severe_loss') {
      t.L += lossWeight(r)
      t.decisive++
      if (r === 'severe_loss') t.severe_losses++
    }
    else if (r === 'tie') {
      t.T++
    }
    else if (r === 'inert') {
      t.inert++
    }
    else if (r === 'void') {
      t.void++
    }
  }
  t.changes_with_wins = changes.size
  return t
}

/** The automatic retirement condition for a trial lesson, or null. `firstInert` counts inert results among its first probes. */
export function retireReason(t: Tally, firstInert: number): string | null {
  const r = PARAMS.lessons.retire
  if (t.L - t.W >= r.lossMargin) return `auto: L−W=${t.L - t.W}`
  if (firstInert >= r.inertMax) return `auto: ${firstInert} of the first ${r.inertWindow} probes inert`
  if (t.decisive >= r.maxDecisive) return `auto: ${t.decisive} decisive probes without adoption`
  if (t.total >= r.maxTotal) return `auto: ${t.total} probes without adoption`
  return null
}

export function meetsAdoptionBar(t: Tally, scope: 'project' | 'global'): boolean {
  if (scope === 'global') return t.W >= PARAMS.lessons.globalAdopt.minWins && t.L <= PARAMS.lessons.globalAdopt.maxLosses
  const a = PARAMS.lessons.adopt
  return t.W >= a.minWins && t.W - t.L >= a.minMargin && t.changes_with_wins >= a.minChanges && t.severe_losses === 0
}

/** Inert results among the first probes of a lesson, in log order. */
export function firstInertCount(events: ProbeEventLike[], scope: string, lessonId: string): number {
  const probes = events
    .filter(e => e.kind === 'probe' && e.payload.mode === 'lesson' && e.payload.lesson_id === lessonId && e.payload.lesson_scope === scope && e.payload.skip_reason === null)
    .sort((a, b) => a.seq - b.seq)
    .slice(0, PARAMS.lessons.retire.inertWindow)
  return probes.filter(e => probeResult(e.payload as ProbePayload) === 'inert').length
}
