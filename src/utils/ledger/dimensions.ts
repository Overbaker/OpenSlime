import type { Invocation, LedgerEvent } from './schema'
import { MAX_NAMES } from './context'
import { DIMENSIONS } from './schema'
import { PARAMS } from './params'
import { holm, newcombe, probit, zStar } from './stats'
import { bySeq, byCodePoint, classify, pairOutcomes, round4 } from './summary'

export const DIMENSION_KEYS = ['skill', 'mcp-tool', 'mcp-server', 'practice', 'output-style', 'backend', 'role', 'model', 'stage', 'change-kind', 'window'] as const
export type DimensionKey = typeof DIMENSION_KEYS[number]
export const METRICS = ['later_critical', 'verify_fail', 'contribution'] as const
export type Metric = typeof METRICS[number]
export type Source = 'observed' | 'self-reported' | 'recorded'

const SOURCE: Record<DimensionKey, Source> = {
  'skill': 'recorded',
  'mcp-tool': 'self-reported',
  'mcp-server': 'observed',
  'practice': 'self-reported',
  'output-style': 'observed',
  'backend': 'recorded',
  'role': 'recorded',
  'model': 'self-reported',
  'stage': 'recorded',
  'change-kind': 'self-reported',
  'window': 'recorded',
}

/**
 * What a unit is known to contain. `partial` means some of it is unknown (an old invocation without the field, an
 * unreadable or truncated config list): the unit is in the with arm of the items it is known to contain and in
 * neither arm of any other item.
 */
interface Membership {
  known: Set<string>
  partial: boolean
}

/** A unit of evidence: x events out of n trials, tagged with the run it came from. */
interface Unit {
  run: string
  x: number
  n: number
  m: Membership
}

export interface ArmStats {
  n: number
  x: number
  runs: number
  rate: number | null
}

export interface ItemRow {
  item: string
  metric: Metric
  with: ArmStats
  without: ArmStats
  status: 'tested' | 'insufficient' | 'no-variation'
  diff: number | null
  interval: [number, number] | null
  z: number | null
  rejected: boolean
  direction: 'better' | 'worse' | null
  /** Items with the identical unit set; tested once, on this row. */
  aliased_with: string[]
  /** Set on an alias: the item whose test this row repeats (it is not counted in Holm m again). */
  aliased_of: string | null
}

export interface ItemVerdict {
  item: string
  verdict: 'associated-better' | 'associated-worse' | 'mixed' | 'none' | 'insufficient' | 'no-variation'
  rows: ItemRow[]
  cost: CostRow | null
}

export interface CostArm {
  n: number
  runs: number
  tokens: number | null
  usd: number | null
}

export interface CostRow {
  with: CostArm
  without: CostArm
  label: 'costs more, not better' | null
}

export interface DimensionView {
  by: DimensionKey
  source: Source
  holm_m: number
  items: ItemVerdict[]
  note: 'associations, not causes'
}

export const PRACTICES = ['plan-first', 'tdd', 'pbt', 'repro-first', 'spec-read', 'callers-read', 'parallel-review', 'blind-review', 'worktree', 'typecheck', 'lint', 'small-commits'] as const
const INVOCATION_DIMS: readonly DimensionKey[] = ['skill', 'backend', 'role', 'model', 'mcp-tool', 'practice']
const LOWER_IS_BETTER: Record<Metric, boolean> = { later_critical: true, verify_fail: true, contribution: false }

interface Anchor {
  anchor: number
  windowDays: number
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null
}

/** One invocation's items for an invocation dimension, or null when it did not report the field. */
function invItems(by: DimensionKey, inv: Record<string, any>): string[] | null {
  switch (by) {
    case 'skill': return strings(inv.skills)
    case 'backend': return typeof inv.backend === 'string' ? [inv.backend] : null
    case 'role': return typeof inv.role === 'string' ? [inv.role] : null
    case 'model': return typeof inv.model === 'string' ? [inv.model] : null
    case 'mcp-tool': return strings(inv.mcp_tools)
    case 'practice': {
      const list = strings(inv.practices)
      return list && list.map(s => ((PRACTICES as readonly string[]).includes(s) ? s : '(other)'))
    }
    default: return null
  }
}

function windowLabel(k: number, w: number): string {
  return k >= 5 ? 'older' : `${k * w}-${(k + 1) * w}d`
}

function known(items: string[]): Membership {
  return { known: new Set(items), partial: false }
}

const UNKNOWN: Membership = { known: new Set(), partial: true }

/** A stage event's membership for a dimension. */
function stageMembership(by: DimensionKey, e: LedgerEvent, a: Anchor): Membership {
  const p = e.payload
  switch (by) {
    case 'stage': return known([e.stage])
    case 'change-kind': return typeof p.change_kind === 'string' ? known([p.change_kind]) : UNKNOWN
    case 'window': {
      const k = Math.floor((a.anchor - Date.parse(e.recorded_at)) / (a.windowDays * 86_400_000))
      return known([windowLabel(Math.max(0, k), a.windowDays)])
    }
    case 'output-style': {
      const s = (e as any).context?.output_style
      return typeof s === 'string' ? known([s]) : UNKNOWN
    }
    case 'mcp-server': {
      const m = (e as any).context?.mcp_servers
      if (!m || typeof m !== 'object') return UNKNOWN
      const lists = [m.user, m.local, m.project].map(strings)
      // A null scope could not be read, and a full list may have been cut at the cap: neither proves absence.
      return { known: new Set(lists.flatMap(l => l ?? [])), partial: lists.some(l => l === null || l.length >= MAX_NAMES) }
    }
    default: {
      // The orchestrator line was added by a template change; counting it would split stages by template version.
      const invs = ((p.invocations ?? []) as Record<string, any>[]).filter(inv => inv.role !== 'orchestrator')
      const lists = invs.map(inv => invItems(by, inv))
      // No invocations is known membership for recorded fields, but unknown for self-reported ones.
      const selfReported = SOURCE[by] === 'self-reported'
      return { known: new Set(lists.flatMap(l => l ?? [])), partial: (selfReported && !lists.length) || lists.some(l => l === null) }
    }
  }
}

/** One invocation's membership: its own fields for invocation dimensions, else its stage's. */
function invocationMembership(by: DimensionKey, e: LedgerEvent, inv: Record<string, any>, a: Anchor): Membership {
  if (!INVOCATION_DIMS.includes(by)) return stageMembership(by, e, a)
  if (inv.role === 'orchestrator') return UNKNOWN
  const own = invItems(by, inv)
  return own === null ? UNKNOWN : known(own)
}

/** Units for one metric: paired stage events for outcome metrics, non-orchestrator invocations for contribution. */
function unitsFor(metric: Metric, by: DimensionKey, stages: LedgerEvent[], pairs: ReturnType<typeof pairOutcomes>, a: Anchor): Unit[] {
  const out: Unit[] = []
  if (metric === 'contribution') {
    for (const e of stages) {
      for (const inv of e.payload.invocations as Invocation[]) {
        if (inv.role === 'orchestrator') continue
        const n = (inv.accepted ?? 0) + (inv.rejected ?? 0)
        if (n) out.push({ run: e.run_id, x: inv.accepted ?? 0, n, m: invocationMembership(by, e, inv as any, a) })
      }
    }
    return out
  }
  const kind = metric === 'later_critical' ? 'review' : 'verify'
  for (const e of stages) {
    const v = pairs.get(e.event_id)?.[kind]
    if (v !== undefined) out.push({ run: e.run_id, x: v === 0 ? 1 : 0, n: 1, m: stageMembership(by, e, a) })
  }
  return out
}

/** Running totals with a per-run unit count, so an arm's distinct runs can be derived by subtraction. */
class Acc {
  x = 0
  n = 0
  perRun = new Map<string, number>()
  add(u: { run: string, x: number, n: number }): void {
    this.x += u.x
    this.n += u.n
    this.perRun.set(u.run, (this.perRun.get(u.run) ?? 0) + 1)
  }

  stats(): ArmStats {
    return { n: this.n, x: this.x, runs: this.perRun.size, rate: this.n ? round4(this.x / this.n) : null }
  }

  /** `this` minus a subset of its units. */
  minus(sub: Acc): ArmStats {
    let runs = this.perRun.size
    for (const [r, c] of sub.perRun) if (c === this.perRun.get(r)) runs--
    const n = this.n - sub.n
    const x = this.x - sub.x
    return { n, x, runs, rate: n ? round4(x / n) : null }
  }
}

interface ItemAcc {
  all: Acc
  complete: Acc
  units: number[]
}

/**
 * One pass over the units: per item, every unit known to contain it (with arm) and the complete ones among them.
 * The without arm is then the complete units minus the complete ones that contain the item.
 */
function accumulate(units: Unit[]): { complete: Acc, items: Map<string, ItemAcc> } {
  const complete = new Acc()
  const items = new Map<string, ItemAcc>()
  units.forEach((u, i) => {
    if (!u.m.partial) complete.add(u)
    for (const it of u.m.known) {
      let a = items.get(it)
      if (!a) items.set(it, a = { all: new Acc(), complete: new Acc(), units: [] })
      a.all.add(u)
      if (!u.m.partial) a.complete.add(u)
      a.units.push(i)
    }
  })
  return { complete, items }
}

function costArm(n: number, runs: number, tokens: { sum: number, n: number }, usd: { sum: number, n: number }): CostArm {
  return { n, runs, tokens: tokens.n ? round4(tokens.sum / tokens.n) : null, usd: usd.n ? round4(usd.sum / usd.n) : null }
}

class CostAcc {
  rows = new Acc()
  tokens = { sum: 0, n: 0 }
  usd = { sum: 0, n: 0 }
  add(run: string, cost: { tokens?: number | null, usd?: number | null }): void {
    this.rows.add({ run, x: 0, n: 1 })
    if (typeof cost.tokens === 'number') {
      this.tokens.sum += cost.tokens
      this.tokens.n++
    }
    if (typeof cost.usd === 'number') {
      this.usd.sum += cost.usd
      this.usd.n++
    }
  }
}

/** Mean tokens and USD per arm over invocations that report cost; shown only with ≥ minRuns runs per arm. Never tested. */
function costRows(by: DimensionKey, stages: LedgerEvent[], a: Anchor): (item: string) => CostRow | null {
  const complete = new CostAcc()
  const items = new Map<string, { all: CostAcc, complete: CostAcc }>()
  for (const e of stages) {
    for (const inv of e.payload.invocations as Record<string, any>[]) {
      // Orchestrator lines exist since a template change; mixing them in would split cost by template version.
      if (!inv.cost || typeof inv.cost !== 'object' || inv.role === 'orchestrator') continue
      const m = invocationMembership(by, e, inv, a)
      if (!m.partial) complete.add(e.run_id, inv.cost)
      for (const it of m.known) {
        let c = items.get(it)
        if (!c) items.set(it, c = { all: new CostAcc(), complete: new CostAcc() })
        c.all.add(e.run_id, inv.cost)
        if (!m.partial) c.complete.add(e.run_id, inv.cost)
      }
    }
  }
  return (item) => {
    const c = items.get(item)
    if (!c) return null
    const w = costArm(c.all.rows.n, c.all.rows.perRun.size, c.all.tokens, c.all.usd)
    const rest = complete.rows.minus(c.complete.rows)
    const sub = (t: { sum: number, n: number }, s: { sum: number, n: number }) => ({ sum: t.sum - s.sum, n: t.n - s.n })
    const wo = costArm(rest.n, rest.runs, sub(complete.tokens, c.complete.tokens), sub(complete.usd, c.complete.usd))
    if (w.runs < PARAMS.stats.minRuns || wo.runs < PARAMS.stats.minRuns) return null
    const more = (w.tokens !== null && wo.tokens !== null && w.tokens > wo.tokens) || (w.usd !== null && wo.usd !== null && w.usd > wo.usd)
    return { with: w, without: wo, label: more ? 'costs more, not better' : null }
  }
}

export interface ViewOptions {
  windowDays?: number
  runs?: number
}

/** The stage events of the N runs whose latest stage has the highest seq. Outcomes are paired against the whole log. */
function restrictStages(stages: LedgerEvent[], n: number | undefined): LedgerEvent[] {
  if (!n) return stages
  const last = new Map<string, number>()
  for (const e of stages) last.set(e.run_id, Math.max(last.get(e.run_id) ?? 0, e.seq))
  const keep = new Set([...last.entries()].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0])).slice(0, n).map(([r]) => r))
  return stages.filter(e => keep.has(e.run_id))
}

function baseRow(item: string, metric: Metric, w: ArmStats, wo: ArmStats): ItemRow {
  return { item, metric, with: w, without: wo, status: 'no-variation', diff: null, interval: null, z: null, rejected: false, direction: null, aliased_with: [], aliased_of: null }
}

/** Association view for one dimension: gates, Newcombe intervals, Holm across all eligible (item, metric) pairs. */
export function dimensionView(all: LedgerEvent[], by: DimensionKey, opts: ViewOptions = {}): DimensionView {
  const events = bySeq(all)
  const pairs = pairOutcomes(events)
  const stages = restrictStages(events.filter(e => e.kind === 'stage_completed'), opts.runs)
  const maxAt = stages.reduce((m, e) => (e.recorded_at > m ? e.recorded_at : m), '')
  const anchor: Anchor = { anchor: maxAt ? Date.parse(maxAt) : 0, windowDays: opts.windowDays ?? 30 }
  const { minN, minRuns } = PARAMS.stats
  const z = probit(1 - PARAMS.stats.alpha / 2)
  const rows: ItemRow[] = []
  const exact = new Map<ItemRow, number>()
  const aliases: ItemRow[] = []
  for (const metric of METRICS) {
    const { complete, items } = accumulate(unitsFor(metric, by, stages, pairs, anchor))
    const primaries = new Map<string, ItemRow>()
    for (const item of [...items.keys()].sort(byCodePoint)) {
      const acc = items.get(item)!
      const w = acc.all.stats()
      const wo = complete.minus(acc.complete)
      const signature = acc.units.join(',')
      const primary = primaries.get(signature)
      if (primary !== undefined) {
        primary.aliased_with.push(item)
        aliases.push({ ...primary, item, aliased_with: [], aliased_of: primary.item })
        continue
      }
      const row = baseRow(item, metric, w, wo)
      primaries.set(signature, row)
      rows.push(row)
      if (!w.n || !wo.n) continue
      if (w.n < minN || wo.n < minN || w.runs < minRuns || wo.runs < minRuns) {
        row.status = 'insufficient'
        continue
      }
      const d = w.x / w.n - wo.x / wo.n
      const iv = newcombe(w.x, w.n, wo.x, wo.n, z)
      Object.assign(row, { status: 'tested', diff: round4(d), interval: [round4(iv[0]), round4(iv[1])], z: zStar(w.x, w.n, wo.x, wo.n) })
      exact.set(row, d)
    }
  }
  const tested = rows.filter(r => r.status === 'tested')
  const order = [...tested].sort((a, b) => byCodePoint(a.item, b.item) || METRICS.indexOf(a.metric) - METRICS.indexOf(b.metric))
  const rejected = holm(order.map(r => ({ key: `${r.item}\0${r.metric}`, z: r.z! })))
  for (const r of tested) {
    r.rejected = rejected.has(`${r.item}\0${r.metric}`)
    if (r.rejected) r.direction = (exact.get(r)! < 0) === LOWER_IS_BETTER[r.metric] ? 'better' : 'worse'
  }
  // Aliases repeat their primary's (now final) result and are never counted in m.
  const byKey = new Map(rows.map(r => [`${r.item}\0${r.metric}`, r]))
  for (const a of aliases) {
    const p = byKey.get(`${a.aliased_of}\0${a.metric}`)!
    rows.push({ ...p, item: a.item, aliased_with: [], aliased_of: p.item })
  }
  const byItem = new Map<string, ItemRow[]>()
  for (const r of rows) byItem.set(r.item, [...(byItem.get(r.item) ?? []), r])
  const bucket = (name: string) => (name === 'older' ? Infinity : Number.parseInt(name, 10))
  const itemOrder = by === 'window' ? (a: string, b: string) => bucket(a) - bucket(b) : byCodePoint
  const cost = costRows(by, stages, anchor)
  const items: ItemVerdict[] = [...byItem.entries()].sort(([a], [b]) => itemOrder(a, b)).map(([item, rs]) => {
    rs.sort((a, b) => METRICS.indexOf(a.metric) - METRICS.indexOf(b.metric))
    const dirs = new Set(rs.filter(r => r.rejected).map(r => r.direction))
    const verdict: ItemVerdict['verdict'] = dirs.has('better') && dirs.has('worse')
      ? 'mixed'
      : dirs.has('better') ? 'associated-better' : dirs.has('worse') ? 'associated-worse' : rs.some(r => r.status === 'tested') ? 'none' : rs.every(r => r.status === 'no-variation') ? 'no-variation' : 'insufficient'
    const c = cost(item)
    if (c && verdict === 'associated-better') c.label = null
    return { item, verdict, rows: rs, cost: c }
  })
  return { by, source: SOURCE[by], holm_m: tested.length, items, note: 'associations, not causes' }
}

export interface DecisionRow {
  dimension: string
  n: number
  adopted: number
  reversed: number
  overrode: number
  unknown: number
  human_initiated: number
  ai_decisions: { total: number, reporting: number }
}

/** Human vs AI decisions per decision dimension; old events without a dimension count as `unknown`. */
export function decisionView(all: LedgerEvent[]): DecisionRow[] {
  const rows = new Map<string, DecisionRow>([...DIMENSIONS, 'unknown'].map(d => [d, { dimension: d, n: 0, adopted: 0, reversed: 0, overrode: 0, unknown: 0, human_initiated: 0, ai_decisions: { total: 0, reporting: 0 } }]))
  for (const e of all) {
    if (e.kind === 'human_decision') {
      const row = rows.get(e.payload.dimension ?? 'unknown')!
      row.n++
      row[classify(e.payload)]++
      if (e.payload.recommendation === null && e.payload.initial_choice !== null) row.human_initiated++
    }
    else if (e.kind === 'stage_completed' && e.payload.ai_decisions) {
      for (const [dim, count] of Object.entries(e.payload.ai_decisions as Record<string, number>)) {
        const row = rows.get(dim)
        if (!row) continue
        row.ai_decisions.total += count
        row.ai_decisions.reporting++
      }
    }
  }
  return [...rows.values()]
}
