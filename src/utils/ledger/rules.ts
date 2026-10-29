import type { LedgerEvent } from './schema'
import { PARAMS } from './params'
import { bySeq, byCodePoint, calibration, creditedShare, observedValue, pairOutcomes, rate, round4, summarize } from './summary'

export interface RuleStatus {
  id: string
  rule: string
  target: string
  state: 'adopted' | 'revisit'
  evidence: string
}

interface Rule {
  id: string
  rule: string
  target: string
  /** A non-null string means revisit, and says why. */
  revisit: (events: LedgerEvent[]) => string | null
  /** The numbers behind the rule, shown whether or not it is in revisit. */
  evidence: (events: LedgerEvent[]) => string
}

const R = PARAMS.harnessRules

function laterCritical(events: LedgerEvent[]): { critical: number, n: number } {
  const seen = new Set<string>()
  let critical = 0
  let n = 0
  for (const o of bySeq(events)) {
    if (o.kind !== 'outcome' || o.payload.assessment !== 'review') continue
    if (seen.has(o.payload.target_event_id)) continue
    const v = observedValue(o)
    if (v === null) continue
    seen.add(o.payload.target_event_id)
    n++
    if (v === 0) critical++
  }
  return { critical, n }
}

function calibrationWorst(events: LedgerEvent[]): { gap: number, n: number, where: string } | null {
  const stage = events.filter(e => e.kind === 'stage_completed')
  const cal = calibration(stage, pairOutcomes(events))
  let worst: { gap: number, n: number, where: string } | null = null
  for (const kind of ['verify', 'review'] as const) {
    for (const row of cal[kind]) {
      if (row.gap === null || row.paired < R.calibrationMinN) continue
      if (!worst || Math.abs(row.gap) > Math.abs(worst.gap)) worst = { gap: row.gap, n: row.paired, where: `${kind}/${row.band}` }
    }
  }
  return worst
}

function adoptions(events: LedgerEvent[]): { adopted: number, retiredForCritical: number } {
  const states = events.filter(e => e.kind === 'lesson_state')
  // Lesson ids repeat across projects; key by project like the summary does.
  const key = (e: LedgerEvent) => `${e.project_id}/${e.payload.scope}/${e.payload.lesson_id}`
  const adopted = new Set(states.filter(e => e.payload.to === 'adopted').map(key))
  const retired = new Set(states
    .filter(e => e.payload.from === 'adopted' && e.payload.to === 'retired' && String(e.payload.reason).startsWith('critical:'))
    .map(key))
  return { adopted: adopted.size, retiredForCritical: [...retired].filter(k => adopted.has(k)).length }
}

function budget(events: LedgerEvent[]): { skips: number, credited: number, opportunities: number } {
  const probes = events.filter(e => e.kind === 'probe')
  const skips = probes.filter(e => e.payload.skip_reason === 'budget').length
  return { skips, credited: creditedShare(events).credited, opportunities: probes.length }
}

function blindPicks(events: LedgerEvent[]): { n: number, disagree: number } {
  const blind = events.filter(e => e.kind === 'human_decision' && e.payload.blind)
  return { n: blind.length, disagree: blind.filter(e => e.payload.final_choice !== 'with-lesson').length }
}

function reviewerStats(events: LedgerEvent[]): { contribution: number | null, adjudicated: number } {
  const role = summarize(events).participants.role.find(g => g.name === 'reviewer')
  return { contribution: role?.contribution ?? null, adjudicated: role?.adjudicated ?? 0 }
}

/** OpenSlime's own rules, registered as adopted harness lessons that evidence can flag. Never stored; never edited automatically. */
export const HARNESS_RULES: Rule[] = [
  {
    id: 'H-0001',
    rule: 'Stage confidence formula',
    target: 'osm-report.md',
    revisit: (ev) => {
      const w = calibrationWorst(ev)
      return w && Math.abs(w.gap) > R.calibrationGap ? `calibration gap ${w.gap} at ${w.where} (n=${w.n})` : null
    },
    evidence: (ev) => {
      const w = calibrationWorst(ev)
      return w ? `worst gap ${w.gap} at ${w.where} (n=${w.n})` : `no band with n≥${R.calibrationMinN}`
    },
  },
  {
    id: 'H-0002',
    rule: 'Probe win rule',
    target: 'params',
    revisit: (ev) => {
      const a = adoptions(ev)
      return a.adopted >= R.winRuleMinAdoptions && a.retiredForCritical / a.adopted >= R.winRuleRetiredShare
        ? `${a.retiredForCritical}/${a.adopted} adopted lessons retired for a Critical`
        : null
    },
    evidence: (ev) => {
      const a = adoptions(ev)
      return `${a.retiredForCritical}/${a.adopted} adopted lessons retired for a Critical`
    },
  },
  {
    id: 'H-0003',
    rule: 'Probe budget',
    target: 'params',
    revisit: (ev) => {
      const b = budget(ev)
      return b.opportunities >= R.budgetMinOpportunities && b.skips > b.credited ? `budget skips ${b.skips} > credited ${b.credited} (n=${b.opportunities})` : null
    },
    evidence: (ev) => {
      const b = budget(ev)
      return `budget skips ${b.skips}, credited ${b.credited} (n=${b.opportunities})`
    },
  },
  {
    id: 'H-0004',
    rule: 'Adoption bar and blind-first question',
    target: 'params, impl.md',
    revisit: (ev) => {
      const b = blindPicks(ev)
      return b.n >= R.blindMinN && b.disagree / b.n >= R.blindDisagreeShare ? `blind picks disagree ${b.disagree}/${b.n}` : null
    },
    evidence: (ev) => {
      const b = blindPicks(ev)
      return `blind picks disagree ${b.disagree}/${b.n}`
    },
  },
  {
    id: 'H-0005',
    rule: 'Reviewer prompts',
    target: '.ccg/prompts/*/reviewer.md',
    revisit: (ev) => {
      const r = reviewerStats(ev)
      if (r.adjudicated >= R.reviewerMinN && (r.contribution ?? 0) < R.reviewerContribution) return `reviewer contribution ${r.contribution} (n=${r.adjudicated})`
      const c = laterCritical(ev)
      if (c.n >= R.laterCriticalMinN && c.critical / c.n > R.laterCriticalRate) return `later Critical rate ${round4(c.critical / c.n)} (n=${c.n})`
      return null
    },
    evidence: (ev) => {
      const r = reviewerStats(ev)
      const c = laterCritical(ev)
      return `reviewer contribution ${r.contribution ?? 'unknown'} (n=${r.adjudicated}); later Critical rate ${rate(c.critical, c.n) ?? 'unknown'} (n=${c.n})`
    },
  },
]

/**
 * The events that belong to one install cohort. Outcomes follow the stage event they target (decision 12),
 * so an outcome recorded after a reinstall still counts for the cohort that produced the work.
 */
export function cohortView(events: LedgerEvent[], install: string): LedgerEvent[] {
  const stageInstall = new Map(events.filter(e => e.kind === 'stage_completed').map(e => [e.event_id, e.harness?.install]))
  return events.filter(e => (e.kind === 'outcome' ? stageInstall.get(e.payload.target_event_id) : e.harness?.install) === install)
}

export function evaluateRules(events: LedgerEvent[]): RuleStatus[] {
  return HARNESS_RULES.map((r) => {
    const why = r.revisit(events)
    return { id: r.id, rule: r.rule, target: r.target, state: why ? 'revisit' : 'adopted', evidence: why ?? r.evidence(events) }
  })
}

export interface Cohort {
  install: string
  events: number
  first: string
  last: string
  changed: string[]
  calibration_gap: { verify: number | null, verify_n: number, review: number | null, review_n: number }
  later_critical: { rate: number | null, n: number }
  overrode: { rate: number | null, n: number }
  credited_probes: { rate: number | null, n: number }
}

function sufficient(num: number, n: number): number | null {
  return n < PARAMS.summary.minCohortN ? null : rate(num, n)
}

function mergedFiles(events: LedgerEvent[]): { files: Record<string, string | null>, params: string | null } {
  const files: Record<string, string | null> = {}
  let params: string | null = null
  for (const e of events) {
    Object.assign(files, e.harness?.files ?? {})
    params = e.harness?.params ?? params
  }
  return { files, params }
}

function overallGap(stage: LedgerEvent[], pairs: ReturnType<typeof pairOutcomes>, kind: 'verify' | 'review'): { gap: number | null, n: number } {
  let n = 0
  let stated = 0
  let observed = 0
  for (const e of stage) {
    const v = pairs.get(e.event_id)?.[kind]
    if (v === undefined) continue
    n++
    stated += e.payload.confidence.percent
    observed += v
  }
  return { gap: n < PARAMS.summary.minCohortN ? null : round4(stated / n / 100 - observed / n), n }
}

/** Events grouped by `harness.install` in order of first appearance; the last `cohorts` groups. */
export function cohorts(all: LedgerEvent[]): { cohorts: Cohort[], omitted: number } {
  const events = bySeq(all)
  const pairs = pairOutcomes(events)
  const order: string[] = []
  const groups = new Map<string, LedgerEvent[]>()
  for (const e of events) {
    const key = e.harness?.install ?? 'unknown'
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(e)
  }
  const result: Cohort[] = []
  let previous: ReturnType<typeof mergedFiles> | null = null
  for (const key of order) {
    const g = groups.get(key)!
    const merged = mergedFiles(g)
    const changed: string[] = []
    if (previous) {
      for (const f of new Set([...Object.keys(previous.files), ...Object.keys(merged.files)])) {
        if (f in previous.files && f in merged.files && previous.files[f] !== merged.files[f]) changed.push(f)
      }
      if (previous.params !== merged.params) changed.push('params')
    }
    previous = merged
    const stage = g.filter(e => e.kind === 'stage_completed')
    const v = overallGap(stage, pairs, 'verify')
    const r = overallGap(stage, pairs, 'review')
    let critical = 0
    let reviewN = 0
    for (const e of stage) {
      const value = pairs.get(e.event_id)?.review
      if (value === undefined) continue
      reviewN++
      if (value === 0) critical++
    }
    const decisions = g.filter(e => e.kind === 'human_decision' && e.payload.recommendation !== null)
    const overrode = decisions.filter(e => e.payload.final_choice !== e.payload.recommendation).length
    const probes = creditedShare(g)
    result.push({
      install: key,
      events: g.length,
      first: g[0].recorded_at.slice(0, 10),
      last: g.at(-1)!.recorded_at.slice(0, 10),
      changed: changed.sort(byCodePoint),
      calibration_gap: { verify: v.gap, verify_n: v.n, review: r.gap, review_n: r.n },
      later_critical: { rate: sufficient(critical, reviewN), n: reviewN },
      overrode: { rate: sufficient(overrode, decisions.length), n: decisions.length },
      credited_probes: { rate: sufficient(probes.credited, probes.total), n: probes.total },
    })
  }
  const keep = PARAMS.summary.cohorts
  return { cohorts: result.slice(-keep), omitted: Math.max(0, result.length - keep) }
}
