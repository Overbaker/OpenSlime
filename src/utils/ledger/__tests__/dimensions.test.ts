import type { LedgerEvent } from '../schema'
import { describe, expect, it, vi } from 'vitest'
import { decisionView, dimensionView } from '../dimensions'
import { PARAMS } from '../params'
import { bound, dimensionLines, parseBounds } from '../render'
import { mulberry32 } from './fixtures'
import { decision, inv, outcome, stage } from './events'

/** n reviewed stages spread over `runs` runs; `bad` of them get a critical finding. */
function reviewed(n: number, runs: number, bad: number, invocation: any, tag: string, over: Partial<LedgerEvent> = {}): LedgerEvent[] {
  const out: LedgerEvent[] = []
  for (let i = 0; i < n; i++) {
    const s = stage(70, [invocation], { run_id: `${tag}-${i % runs}`, ...over })
    out.push(s, outcome(s, 'review', 'failed', i < bad ? 1 : 0))
  }
  return out
}

const withSkill = (extra: Record<string, any> = {}) => ({ ...inv('codex', null, null, 'succeeded', ['s']), ...extra })
const without = (extra: Record<string, any> = {}) => ({ ...inv('codex', null, null, 'succeeded', []), ...extra })

function row(events: LedgerEvent[], by: Parameters<typeof dimensionView>[1], item: string, metric = 'later_critical') {
  return dimensionView(events, by).items.find(i => i.item === item)?.rows.find(r => r.metric === metric)
}

describe('Q9: gates', () => {
  it('needs n ≥ 10 and ≥ 5 runs in each arm', () => {
    const ok = [...reviewed(10, 5, 9, withSkill(), 'w'), ...reviewed(10, 5, 0, without(), 'o')]
    expect(row(ok, 'skill', 's')).toMatchObject({ status: 'tested', with: { n: 10, runs: 5 }, without: { n: 10, runs: 5 } })
    expect(row([...reviewed(9, 5, 9, withSkill(), 'w'), ...reviewed(10, 5, 0, without(), 'o')], 'skill', 's')?.status).toBe('insufficient')
    expect(row([...reviewed(10, 4, 9, withSkill(), 'w'), ...reviewed(10, 5, 0, without(), 'o')], 'skill', 's')?.status).toBe('insufficient')
    const v = dimensionView(ok, 'skill')
    expect(v.items[0]).toMatchObject({ item: 's', verdict: 'associated-worse' })
    expect(v.note).toBe('associations, not causes')
  })

  it('labels an item present everywhere no-variation and leaves it out of m', () => {
    const all = reviewed(20, 10, 3, withSkill(), 'w')
    const v = dimensionView(all, 'skill')
    expect(v.items[0]).toMatchObject({ item: 's', verdict: 'no-variation' })
    expect(v.holm_m).toBe(0)
  })

  it('tests identical unit sets once and marks the alias', () => {
    const both = { ...inv('codex', null, null, 'succeeded', ['a', 'b']) }
    const v = dimensionView([...reviewed(10, 5, 9, both, 'w'), ...reviewed(10, 5, 0, without(), 'o')], 'skill')
    expect(v.items.map(i => i.item)).toEqual(['a', 'b'])
    expect(v.items[0].rows[0].aliased_with).toEqual(['b'])
    expect(v.items[1]).toMatchObject({ verdict: v.items[0].verdict, rows: [{ aliased_of: 'a', status: 'tested' }] })
    expect(v.holm_m).toBe(1)
  })
})

describe('review fixes: orchestrator and empty stages', () => {
  it('never puts the orchestrator into backend or role arms, and keeps empty stages known for recorded fields', () => {
    const orch = { ...inv('claude', 9, 0, 'succeeded', [], 'orchestrator') }
    const events: LedgerEvent[] = []
    for (let i = 0; i < 12; i++) {
      const s = stage(70, i < 6 ? [orch, inv('codex', null, null)] : [], { run_id: `o${i}` })
      events.push(s, outcome(s, 'review', 'failed', 0))
    }
    const role = dimensionView(events, 'role')
    expect(role.items.map(i => i.item)).toEqual(['reviewer'])
    expect(role.items[0].rows.find(r => r.metric === 'later_critical')).toMatchObject({ with: { n: 6 }, without: { n: 6 } })
    expect(row(events, 'mcp-tool', 'x')).toBeUndefined()
    const costed = Array.from({ length: 12 }, (_, i) => stage(70, [{ ...orch, cost: { tokens: 40000, usd: null } }, { ...inv('codex', 1, 0), cost: { tokens: 1000, usd: null } }], { run_id: `w${i}`, stage: i < 6 ? 'impl' : 'review' }))
    expect(dimensionView(costed, 'stage').items[0].cost?.with.tokens).toBe(1000)
  })
})

describe('Q10: unknown membership', () => {
  it('keeps old events out of both arms of a self-reported item', () => {
    const rand = mulberry32(10)
    for (let t = 0; t < 20; t++) {
      const fresh = [...reviewed(10 + Math.floor(rand() * 5), 5, Math.floor(rand() * 10), withSkill({ mcp_tools: ['c7:q'] }), `w${t}`), ...reviewed(10, 5, Math.floor(rand() * 5), without({ mcp_tools: [] }), `o${t}`)]
      const old = reviewed(1 + Math.floor(rand() * 20), 3, Math.floor(rand() * 2), without(), `old${t}`)
      const a = row(fresh, 'mcp-tool', 'c7:q')
      const b = row([...old, ...fresh], 'mcp-tool', 'c7:q')
      expect(b?.with).toEqual(a?.with)
      expect(b?.without).toEqual(a?.without)
    }
  })

  it('keeps observed and self-reported sources apart', () => {
    const ctx = { context: { v: 1, mcp_servers: { user: ['context7'], local: [], project: [], total: 1 } } } as any
    const events = reviewed(3, 3, 0, without({ mcp_tools: ['context7:query-docs'] }), 'r', ctx)
    expect(dimensionView(events, 'mcp-server')).toMatchObject({ source: 'observed', items: [{ item: 'context7' }] })
    expect(dimensionView(events, 'mcp-tool')).toMatchObject({ source: 'self-reported', items: [{ item: 'context7:query-docs' }] })
  })

  it('folds unknown practices into (other) and excludes the orchestrator from contribution', () => {
    const s = stage(70, [{ ...inv('claude', 5, 0, 'succeeded', [], 'orchestrator'), practices: ['tdd'] }, { ...inv('codex', 1, 1), practices: ['vibes'] }])
    const v = dimensionView([s], 'practice')
    expect(v.items.map(i => i.item)).toEqual(['(other)'])
    expect(v.items[0].rows[0].with).toMatchObject({ n: 2, x: 1 })
  })
})

describe('review fixes', () => {
  it('excludes a stage with one non-reporting invocation from the without arm only', () => {
    const mixed = (tools: string[]) => stage(70, [without({ mcp_tools: tools }), without()])
    const events: LedgerEvent[] = []
    for (let i = 0; i < 12; i++) {
      const s = mixed(i < 6 ? ['c7:q'] : [])
      events.push({ ...s, run_id: `m${i}` }, outcome(s, 'review', 'failed', 0))
    }
    const r = row(events, 'mcp-tool', 'c7:q')!
    expect(r.with.n).toBe(6)
    expect(r.without.n).toBe(0)
  })

  it('treats an unreadable mcp scope as unknown, not as no servers', () => {
    const ctx = (user: string[] | null) => ({ context: { v: 1, mcp_servers: { user, local: [], project: [], total: 0 } } }) as any
    const events = [...reviewed(3, 3, 0, without(), 'a', ctx(['c7'])), ...reviewed(3, 3, 0, without(), 'b', ctx(null))]
    expect(row(events, 'mcp-server', 'c7')).toMatchObject({ with: { n: 3 }, without: { n: 0 } })
  })

  it('treats a scope cut at the name cap as unknown', () => {
    const full = Array.from({ length: 100 }, (_, i) => `s${String(i).padStart(3, '0')}`)
    const ctx = (user: string[]) => ({ context: { v: 1, mcp_servers: { user, local: [], project: [], total: user.length } } }) as any
    const events = [...reviewed(3, 3, 0, without(), 'a', ctx(['zz'])), ...reviewed(3, 3, 0, without(), 'b', ctx(full))]
    expect(row(events, 'mcp-server', 'zz')).toMatchObject({ with: { n: 3 }, without: { n: 0 } })
  })

  it('caps aliased_with in text', () => {
    const many = Array.from({ length: 25 }, (_, i) => `k${String(i).padStart(2, '0')}`)
    const v = dimensionView([...reviewed(3, 3, 0, inv('codex', null, null, 'succeeded', many), 'w'), ...reviewed(3, 3, 0, without(), 'o')], 'skill')
    expect(v.items[0].rows[0].aliased_with).toHaveLength(24)
    expect(dimensionLines('t', v).join('\n')).toContain(`, … +${24 - PARAMS.stats.maxRows}`)
  })

  it('pairs --runs stages with outcomes recorded by later runs', () => {
    const events: LedgerEvent[] = []
    for (let i = 0; i < 6; i++) {
      const s = stage(70, [withSkill()], { run_id: `impl-${i}` })
      events.push(s, outcome(s, 'review', 'failed', 1, { run_id: `review-${i}` }))
    }
    expect(row(events, 'skill', 's', 'later_critical')?.with.n).toBe(6)
    expect(row(events, 'skill', 's', 'later_critical')?.with.runs).toBe(6)
    expect(dimensionView(events, 'skill', { runs: 2 }).items[0].rows[0].with).toMatchObject({ n: 2, runs: 2 })
  })

  it('arms match a brute-force split on random logs', () => {
    const rand = mulberry32(99)
    const names = ['a', 'b', 'c', 'd']
    const events: LedgerEvent[] = []
    for (let i = 0; i < 120; i++) {
      const invs = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => without(rand() < 0.2 ? {} : { mcp_tools: names.filter(() => rand() < 0.4) }))
      const s = stage(70, invs, { run_id: `r${Math.floor(rand() * 15)}` })
      events.push(s, outcome(s, 'review', 'failed', rand() < 0.3 ? 1 : 0))
    }
    const v = dimensionView(events, 'mcp-tool')
    for (const name of names) {
      const r = v.items.find(i => i.item === name)?.rows.find(x => x.metric === 'later_critical')
      if (!r) continue
      const units = events.filter(e => e.kind === 'stage_completed').map((e) => {
        const lists = (e.payload.invocations as any[]).map(x => x.mcp_tools ?? null)
        const has = lists.some(l => l?.includes(name))
        const unknown = lists.some(l => l === null)
        return { e, arm: has ? 'with' : unknown ? null : 'without' }
      })
      for (const arm of ['with', 'without'] as const) {
        const us = units.filter(u => u.arm === arm)
        expect(r[arm].n).toBe(us.length)
        expect(r[arm].runs).toBe(new Set(us.map(u => u.e.run_id)).size)
      }
    }
  })
})

describe('Q11: window anchoring', () => {
  it('is independent of the clock and of a uniform time shift', () => {
    const day = 86_400_000
    const base = Date.parse('2026-01-01T00:00:00Z')
    const events = Array.from({ length: 30 }, (_, i) => stage(70, [inv('codex', 1, 0)], { recorded_at: new Date(base + i * 9 * day).toISOString(), run_id: `r${i}` }))
    const names = (es: LedgerEvent[]) => dimensionView(es, 'window').items.map(i => [i.item, i.rows[0].with.n])
    const before = names(events)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-05-05T00:00:00Z'))
    expect(names(events)).toEqual(before)
    vi.useRealTimers()
    const shifted = events.map(e => ({ ...e, recorded_at: new Date(Date.parse(e.recorded_at) + 1234 * day).toISOString() }))
    expect(names(shifted)).toEqual(before)
    expect(before.map(([n]) => n)).toEqual(['0-30d', '30-60d', '60-90d', '90-120d', '120-150d', 'older'])
  })
})

describe('cost per arm', () => {
  it('shows "costs more, not better" when the with-arm spends more without being better', () => {
    const cost = (tokens: number) => ({ cost: { tokens, usd: null } })
    const events = [...reviewed(10, 5, 2, withSkill(cost(2000)), 'w'), ...reviewed(10, 5, 2, without(cost(1000)), 'o')]
    const item = dimensionView(events, 'skill').items[0]
    expect(item.verdict).toBe('none')
    expect(item.cost).toMatchObject({ with: { n: 10, runs: 5, tokens: 2000 }, without: { n: 10, runs: 5, tokens: 1000 }, label: 'costs more, not better' })
    expect(dimensionView(events.slice(0, 18), 'skill').items[0].cost).toBeNull()
  })

  it('clears the label when the item is associated-better', () => {
    const cost = (tokens: number) => ({ cost: { tokens, usd: null } })
    const events = [...reviewed(10, 5, 0, withSkill(cost(2000)), 'w'), ...reviewed(10, 5, 9, without(cost(1000)), 'o')]
    const item = dimensionView(events, 'skill').items[0]
    expect(item.verdict).toBe('associated-better')
    expect(item.cost).toMatchObject({ with: { tokens: 2000 }, label: null })
  })
})

describe('Q12: decisions per dimension', () => {
  it('row n sums to the total and classes sum to each row', () => {
    const rand = mulberry32(12)
    const dims = [undefined, 'scope', 'design', 'adoption', 'skill']
    const events = Array.from({ length: 300 }, () => {
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
      const d = decision(['a', 'b', 'c'], pick([null, 'a', 'b']), pick([null, 'a', 'c']), pick(['a', 'b', 'c']))
      const dim = pick(dims)
      if (dim) d.payload.dimension = dim
      return d
    })
    const rows = decisionView(events)
    expect(rows.reduce((s, r) => s + r.n, 0)).toBe(300)
    for (const r of rows) expect(r.adopted + r.reversed + r.overrode + r.unknown).toBe(r.n)
  })
})

describe('Q17: bounded output', () => {
  it('keeps 5,000 items within the caps and counts them all', () => {
    const events = Array.from({ length: 5000 }, (_, i) => stage(70, [inv('codex', 1, 0, 'succeeded', [`skill-${i}`])], { run_id: `r${i % 50}` }))
    const v = dimensionView(events, 'skill')
    expect(v.items).toHaveLength(5000)
    const text = bound(dimensionLines('t', v), parseBounds(undefined, undefined))
    expect(text.split('\n').length - 1).toBeLessThanOrEqual(PARAMS.summary.defaultLines)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PARAMS.summary.defaultBytes)
    expect(dimensionLines('t', v)[0]).toContain(`showing ${PARAMS.stats.maxRows} of 5000 items`)
  })
})
