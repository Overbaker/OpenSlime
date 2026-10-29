import type { Invocation, LedgerEvent } from './schema'
import type { ProbePayload, ProbeResult } from './probe'
import { PARAMS } from './params'
import type { Tally } from './probe'
import { isCredited, lessonTally, meetsAdoptionBar, probeResult } from './probe'

export type Verdict = 'insufficient' | 'keep' | 'revisit'

export interface ParticipantGroup {
  name: string
  invoked: number
  accepted: number
  rejected: number
  unadjudicated: number
  adjudicated: number
  contribution: number | null
  succeeded: number
  failed: number
  skipped: number
  failure_rate: number | null
  runs: number
  verdict: Verdict
  non_additive: boolean
}

export interface BandRow {
  band: 'Low' | 'Medium' | 'High'
  paired: number
  mean_stated: number | null
  observed: number | null
  gap: number | null
}

export interface Calibration {
  verify: BandRow[]
  review: BandRow[]
  unpaired: { verify: number, review: number }
}

export type InfluenceClass = 'adopted' | 'reversed' | 'overrode' | 'unknown'

export interface Influence {
  decisions: number
  classes: Record<InfluenceClass, number>
  first_position: { n: number, rate: number | null }
  blind: { n: number, agreed: number }
  rubber_stamp: { flag: boolean, basis: string | null }
}

export interface ProbeTotals {
  total: number
  results: Record<ProbeResult, number>
  skip_reasons: Record<string, number>
}

export interface LessonStatus {
  counts: Record<'project' | 'global', Record<'candidate' | 'trial' | 'adopted' | 'retired', number>>
  trials: Array<{ id: string, scope: 'project' | 'global', project_id: string } & Pick<Tally, 'W' | 'L' | 'T' | 'inert' | 'void'>>
  pending: Array<{ id: string, scope: 'project' | 'global', project_id: string, W: number, L: number, changes_with_wins: number }>
}

export interface Summary {
  events: number
  lessons: LessonStatus
  participants: { backend: ParticipantGroup[], skill: ParticipantGroup[], role: ParticipantGroup[] }
  calibration: Calibration
  influence: Influence
  probes: ProbeTotals
}

export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}

/** Code-point order, independent of locale. */
export function byCodePoint(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (d !== 0) return d
  }
  return x.length - y.length
}

export function rate(num: number, den: number): number | null {
  return den === 0 ? null : round4(num / den)
}

/** Log order. Multi-log views arrive already merged and renumbered by the loader, so seq alone is the order. */
export function bySeq(events: LedgerEvent[]): LedgerEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq)
}

interface Acc {
  invoked: number
  accepted: number
  rejected: number
  unadjudicated: number
  succeeded: number
  failed: number
  skipped: number
  runs: Set<string>
  nonAdditive: boolean
}

function emptyAcc(): Acc {
  return { invoked: 0, accepted: 0, rejected: 0, unadjudicated: 0, succeeded: 0, failed: 0, skipped: 0, runs: new Set(), nonAdditive: false }
}

function verdict(adjudicated: number, runs: number, contribution: number | null, failureRate: number | null): Verdict {
  if (adjudicated < PARAMS.verdict.minAdjudicated || runs < PARAMS.verdict.minRuns) return 'insufficient'
  return (contribution ?? 0) >= PARAMS.verdict.keepContribution && (failureRate ?? 0) <= PARAMS.verdict.maxFailureRate ? 'keep' : 'revisit'
}

function toGroup(name: string, a: Acc): ParticipantGroup {
  const adjudicated = a.accepted + a.rejected
  const contribution = rate(a.accepted, adjudicated)
  const failure = rate(a.failed, a.succeeded + a.failed)
  return {
    name,
    invoked: a.invoked,
    accepted: a.accepted,
    rejected: a.rejected,
    unadjudicated: a.unadjudicated,
    adjudicated,
    contribution,
    succeeded: a.succeeded,
    failed: a.failed,
    skipped: a.skipped,
    failure_rate: failure,
    runs: a.runs.size,
    verdict: verdict(adjudicated, a.runs.size, contribution, failure),
    non_additive: a.nonAdditive,
  }
}

function participants(stageEvents: LedgerEvent[]): Summary['participants'] {
  const maps = { backend: new Map<string, Acc>(), skill: new Map<string, Acc>(), role: new Map<string, Acc>() }
  for (const e of stageEvents) {
    for (const inv of e.payload.invocations as Invocation[]) {
      const keys: Array<[keyof typeof maps, string]> = [['backend', inv.backend], ['role', inv.role], ...[...new Set(inv.skills)].map(s => ['skill', s] as [keyof typeof maps, string])]
      for (const [kind, name] of keys) {
        const a = maps[kind].get(name) ?? emptyAcc()
        maps[kind].set(name, a)
        a.invoked++
        a.accepted += inv.accepted ?? 0
        a.rejected += inv.rejected ?? 0
        a.unadjudicated += inv.unadjudicated ?? 0
        a[inv.status]++
        if ((inv.accepted ?? 0) + (inv.rejected ?? 0) > 0) a.runs.add(e.run_id)
        if (kind === 'skill' && inv.skills.length > 1) a.nonAdditive = true
      }
    }
  }
  const groups = (m: Map<string, Acc>) => [...m.entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([n, a]) => toGroup(n, a))
  return { backend: groups(maps.backend), skill: groups(maps.skill), role: groups(maps.role) }
}

/** 1, 0, or null (excluded) for one outcome event. */
export function observedValue(outcome: LedgerEvent): number | null {
  const p = outcome.payload
  if (p.result === 'unknown') return null
  if (p.assessment === 'verify') return p.result === 'passed' ? 1 : 0
  return p.critical_count === null ? null : p.critical_count === 0 ? 1 : 0
}

/** For each stage event id, its earliest usable outcome per assessment kind. The stage's own `verify` is never used. */
export function pairOutcomes(events: LedgerEvent[]): Map<string, { verify?: number, review?: number }> {
  const pairs = new Map<string, { verify?: number, review?: number }>()
  for (const o of bySeq(events)) {
    if (o.kind !== 'outcome') continue
    const target = o.payload.target_event_id as string
    const kind = o.payload.assessment as 'verify' | 'review'
    const entry = pairs.get(target) ?? {}
    if (kind in entry) continue
    const v = observedValue(o)
    if (v === null) continue
    entry[kind] = v
    pairs.set(target, entry)
  }
  return pairs
}

const BANDS = ['Low', 'Medium', 'High'] as const

export function calibration(stageEvents: LedgerEvent[], pairs: Map<string, { verify?: number, review?: number }>): Calibration {
  const out: Calibration = { verify: [], review: [], unpaired: { verify: 0, review: 0 } }
  for (const kind of ['verify', 'review'] as const) {
    const acc = new Map(BANDS.map(b => [b, { n: 0, stated: 0, observed: 0 }]))
    for (const e of stageEvents) {
      const v = pairs.get(e.event_id)?.[kind]
      if (v === undefined) {
        out.unpaired[kind]++
        continue
      }
      const a = acc.get(e.payload.confidence.band)!
      a.n++
      a.stated += e.payload.confidence.percent
      a.observed += v
    }
    out[kind] = BANDS.map((band) => {
      const a = acc.get(band)!
      const meanStated = a.n ? round4(a.stated / a.n) : null
      const observed = rate(a.observed, a.n)
      return { band, paired: a.n, mean_stated: meanStated, observed, gap: a.n ? round4(a.stated / a.n / 100 - a.observed / a.n) : null }
    })
  }
  return out
}

export function classify(p: Record<string, any>): InfluenceClass {
  if (p.recommendation === null) return 'unknown'
  if (p.initial_choice !== null && p.initial_choice !== p.final_choice && p.final_choice === p.recommendation) return 'reversed'
  if (p.final_choice !== p.recommendation) return 'overrode'
  return 'adopted'
}

function influence(decisions: LedgerEvent[]): Influence {
  const classes: Record<InfluenceClass, number> = { adopted: 0, reversed: 0, overrode: 0, unknown: 0 }
  let first = 0
  let blind = 0
  let agreed = 0
  for (const d of decisions) {
    classes[classify(d.payload)]++
    if (d.payload.final_position === 0) first++
    if (d.payload.blind) {
      blind++
      if (d.payload.final_choice === 'with-lesson') agreed++
    }
  }
  const firstRate = rate(first, decisions.length)
  const recommended = decisions.filter(d => d.payload.recommendation !== null)
  const window = recommended.slice(-PARAMS.rubberStamp.window)
  const wClasses = window.map(d => classify(d.payload))
  const wAdopted = wClasses.filter(c => c === 'adopted').length
  const wOverrode = wClasses.filter(c => c === 'overrode').length
  let basis: string | null = null
  if (window.length === PARAMS.rubberStamp.window && wAdopted / window.length >= PARAMS.rubberStamp.adoptedShare && wOverrode === 0) {
    basis = `last ${window.length} recommended decisions: ${wAdopted} adopted, 0 overrode`
  }
  else if (decisions.length >= PARAMS.rubberStamp.minDecisions && (firstRate ?? 0) > PARAMS.rubberStamp.firstPositionRate) {
    basis = `first option chosen ${first}/${decisions.length}`
  }
  return {
    decisions: decisions.length,
    classes,
    first_position: { n: decisions.length, rate: firstRate },
    blind: { n: blind, agreed },
    rubber_stamp: { flag: basis !== null, basis },
  }
}

function probes(events: LedgerEvent[]): ProbeTotals {
  const results: Record<ProbeResult, number> = { skipped: 0, confounded: 0, void: 0, inert: 0, win: 0, loss: 0, severe_loss: 0, tie: 0 }
  const skip: Record<string, number> = {}
  for (const e of events) {
    const r = probeResult(e.payload as ProbePayload)
    results[r]++
    if (r === 'skipped') skip[e.payload.skip_reason] = (skip[e.payload.skip_reason] ?? 0) + 1
  }
  const skip_reasons = Object.fromEntries(Object.entries(skip).sort(([a], [b]) => byCodePoint(a, b)))
  return { total: events.length, results, skip_reasons }
}

export function creditedShare(events: LedgerEvent[]): { credited: number, total: number } {
  const ps = events.filter(e => e.kind === 'probe')
  return { credited: ps.filter(e => isCredited(probeResult(e.payload as ProbePayload))).length, total: ps.length }
}

/** Lesson states from lesson_state events; global lessons seen only in probes count as trial. */
function lessonStatus(events: LedgerEvent[]): LessonStatus {
  const zero = () => ({ candidate: 0, trial: 0, adopted: 0, retired: 0 })
  const counts = { project: zero(), global: zero() }
  // Lesson ids repeat across projects (and a global lesson has a separate local state in each), so key by project.
  // The creation event of a promoted lesson lives in the global log; it is not a local state of any project.
  type Key = { id: string, scope: 'project' | 'global', project_id: string, state: keyof ReturnType<typeof zero> }
  const states = new Map<string, Key>()
  for (const e of events) {
    const scope = e.payload.scope ?? e.payload.lesson_scope
    const key = `${e.project_id}/${scope}/${e.payload.lesson_id}`
    if (e.kind === 'lesson_state' && !(scope === 'global' && e.payload.from === null)) states.set(key, { id: e.payload.lesson_id, scope, project_id: e.project_id, state: e.payload.to })
    else if (e.kind === 'probe' && e.payload.lesson_scope === 'global' && e.payload.lesson_id && !states.has(key)) {
      states.set(key, { id: e.payload.lesson_id, scope: 'global', project_id: e.project_id, state: 'trial' })
    }
  }
  const byProject = new Map<string, LedgerEvent[]>()
  for (const e of events) byProject.set(e.project_id, [...(byProject.get(e.project_id) ?? []), e])
  const trials: LessonStatus['trials'] = []
  const pending: LessonStatus['pending'] = []
  const ordered = [...states.values()].sort((a, b) => byCodePoint(a.project_id, b.project_id) || byCodePoint(a.scope, b.scope) || byCodePoint(a.id, b.id))
  for (const l of ordered) {
    counts[l.scope][l.state]++
    if (l.state !== 'trial') continue
    const t = lessonTally(byProject.get(l.project_id) ?? [], l.scope, l.id)
    trials.push({ id: l.id, scope: l.scope, project_id: l.project_id, W: t.W, L: t.L, T: t.T, inert: t.inert, void: t.void })
    if (meetsAdoptionBar(t, l.scope)) pending.push({ id: l.id, scope: l.scope, project_id: l.project_id, W: t.W, L: t.L, changes_with_wins: t.changes_with_wins })
  }
  return { counts, trials, pending }
}

/** Pure fold over one or more logs' events. */
export function summarize(all: LedgerEvent[]): Summary {
  const events = bySeq(all)
  const stage = events.filter(e => e.kind === 'stage_completed')
  return {
    events: events.length,
    lessons: lessonStatus(events),
    participants: participants(stage),
    calibration: calibration(stage, pairOutcomes(events)),
    influence: influence(events.filter(e => e.kind === 'human_decision')),
    probes: probes(events.filter(e => e.kind === 'probe')),
  }
}
