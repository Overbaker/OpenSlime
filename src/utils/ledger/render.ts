import type { Cohort, RuleStatus } from './rules'
import type { ParticipantGroup, Summary } from './summary'
import { PARAMS } from './params'

export interface Bounds {
  limit: number
  maxBytes: number
}

export class BoundsError extends Error {}

export function parseBounds(limit: unknown, maxBytes: unknown): Bounds {
  const num = (v: unknown, def: number, min: number, max: number, name: string): number => {
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max) throw new BoundsError(`${name} must be an integer ${min}..${max}`)
    return n
  }
  return {
    limit: num(limit, PARAMS.summary.defaultLines, 1, PARAMS.summary.maxLines, '--limit'),
    maxBytes: num(maxBytes, PARAMS.summary.defaultBytes, PARAMS.summary.minBytes, PARAMS.summary.maxBytes, '--max-bytes'),
  }
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Cuts a line to at most `max` UTF-8 bytes on a code-point boundary. */
function fitLine(line: string, max: number): string {
  if (bytes(line) <= max) return line
  let out = ''
  for (const ch of line) {
    if (bytes(out + ch) + bytes('…') > max) break
    out += ch
  }
  return `${out}…`
}

/** Keeps whole lines within the line and byte caps; never changes the numbers in them. */
export function bound(lines: string[], b: Bounds): string {
  const notice = (n: number): string => `… +${n} more; run with --limit/--json`
  const out: string[] = []
  let used = 0
  for (let i = 0; i < lines.length; i++) {
    const remaining = lines.length - i
    const reserve = remaining > 1 ? bytes(notice(remaining)) + 1 : 0
    const line = fitLine(lines[i], b.maxBytes - reserve - 1)
    const fitsLines = out.length + 1 + (remaining > 1 ? 1 : 0) <= b.limit
    if (!fitsLines || used + bytes(line) + 1 + reserve > b.maxBytes) {
      out.push(notice(remaining))
      return `${out.join('\n')}\n`
    }
    out.push(line)
    used += bytes(line) + 1
  }
  return `${out.join('\n')}\n`
}

function pct(x: number | null): string {
  return x === null ? 'unknown' : x.toFixed(4)
}

function groupLine(g: ParticipantGroup): string {
  const contrib = g.contribution === null ? 'unknown' : `${g.accepted}/${g.adjudicated} ${pct(g.contribution)}`
  const verdict = g.verdict === 'insufficient' ? `insufficient (n=${g.adjudicated}, runs=${g.runs})` : `${g.verdict} (n=${g.adjudicated})`
  return `  ${g.name}  invoked ${g.invoked} · contribution ${contrib} · failed ${g.failed}/${g.succeeded + g.failed}${g.skipped ? ` · skipped ${g.skipped}` : ''}${g.non_additive ? ' · non-additive' : ''} · ${verdict}`
}

export function summaryLines(title: string, s: Summary, invalid: number): string[] {
  const lines = [`${title} · ${s.events} events${invalid ? ` · invalid: ${invalid}` : ''}`]
  const flag = s.influence.rubber_stamp
  if (flag.flag) lines.push(`⚠ rubber-stamp risk: ${flag.basis}`)

  const c = s.influence.classes
  lines.push(`Human decisions n=${s.influence.decisions}: adopted ${c.adopted} · reversed ${c.reversed} · overrode ${c.overrode} · unknown ${c.unknown} · first-position ${pct(s.influence.first_position.rate)}${s.influence.blind.n ? ` · blind agreed ${s.influence.blind.agreed}/${s.influence.blind.n}` : ''}`)

  for (const kind of ['verify', 'review'] as const) {
    const rows = s.calibration[kind].filter(r => r.paired > 0)
    const cells = rows.map(r => `${r.band} n=${r.paired} stated ${pct(r.mean_stated === null ? null : r.mean_stated / 100)} observed ${pct(r.observed)} gap ${pct(r.gap)}`)
    lines.push(`Calibration ${kind}: ${cells.length ? cells.join(' | ') : 'no paired outcomes'} · unpaired ${s.calibration.unpaired[kind]}`)
  }

  const p = s.probes
  if (p.total) {
    const r = p.results
    const skips = Object.entries(p.skip_reasons).map(([k, v]) => `${k} ${v}`).join(', ')
    lines.push(`Probes n=${p.total}: win ${r.win} · loss ${r.loss} · severe ${r.severe_loss} · tie ${r.tie} · inert ${r.inert} · void ${r.void} · confounded ${r.confounded} · skipped ${r.skipped}${skips ? ` (${skips})` : ''}`)
  }

  const lc = s.lessons.counts
  const scopeLine = (k: 'project' | 'global') => `${k}: trial ${lc[k].trial} · adopted ${lc[k].adopted} · candidate ${lc[k].candidate} · retired ${lc[k].retired}`
  if (Object.values(lc).some(c => Object.values(c).some(n => n > 0))) {
    lines.push(`Lessons ${scopeLine('project')} | ${scopeLine('global')}`)
    const many = new Set([...s.lessons.trials, ...s.lessons.pending].map(x => x.project_id)).size > 1
    const where = (x: { scope: string, project_id: string }) => (many ? `${x.scope}, ${x.project_id}` : x.scope)
    for (const p of s.lessons.pending) lines.push(`  pending adoption: ${p.id} (${where(p)}) W${p.W} L${p.L} · wins from ${p.changes_with_wins} changes`)
    for (const t of s.lessons.trials) lines.push(`  trial ${t.id} (${where(t)}) W${t.W} L${t.L} T${t.T} · inert ${t.inert} · void ${t.void}`)
  }

  for (const kind of ['backend', 'role', 'skill'] as const) {
    const groups = s.participants[kind]
    if (!groups.length) continue
    lines.push(`By ${kind}:`)
    for (const g of groups) lines.push(groupLine(g))
  }
  return lines
}

export function cohortLines(cohorts: Cohort[], omitted: number, invalid = 0): string[] {
  const lines = [`Harness cohorts (by install digest)${omitted ? ` · ${omitted} older omitted` : ''}${invalid ? ` · invalid: ${invalid}` : ''}:`]
  const show = (r: number | null, n: number) => (r === null ? `insufficient (n=${n})` : `${r.toFixed(4)} (n=${n})`)
  for (const c of cohorts) {
    const changed = c.changed.length ? ` · changed: ${c.changed.join(', ')}` : c === cohorts[0] && !omitted ? '' : ' · changed: not observed in shared files'
    lines.push(`${c.install} · ${c.events} events · ${c.first}..${c.last}${changed}`)
    lines.push(`  gap verify ${show(c.calibration_gap.verify, c.calibration_gap.verify_n)} · gap review ${show(c.calibration_gap.review, c.calibration_gap.review_n)} · later Critical ${show(c.later_critical.rate, c.later_critical.n)} · overrode ${show(c.overrode.rate, c.overrode.n)} · credited probes ${show(c.credited_probes.rate, c.credited_probes.n)}`)
  }
  return lines
}

export function ruleLines(install: string, current: RuleStatus[], all: RuleStatus[]): string[] {
  const lines = [`Harness install ${install}`]
  for (let i = 0; i < all.length; i++) {
    const cur = current[i]
    const tot = all[i]
    lines.push(`${tot.id} ${tot.rule} [${tot.target}] · current: ${cur.state} (${cur.evidence}) · all: ${tot.state} (${tot.evidence})`)
  }
  return lines
}
