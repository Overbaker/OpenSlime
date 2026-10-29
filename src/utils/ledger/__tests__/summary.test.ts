import type { LedgerEvent } from '../schema'
import { describe, expect, it } from 'vitest'
import { bound, parseBounds, summaryLines } from '../render'
import { classify, summarize } from '../summary'
import { mulberry32, shuffleKeys } from './fixtures'
import { decision, inv, outcome, stage } from './events'

describe('contribution verdicts', () => {
  it('is insufficient below 10 adjudicated findings or 5 runs', () => {
    const events = Array.from({ length: 6 }, () => stage(70, [inv('codex', 1, 0)]))
    events.push(stage(70, [inv('codex', 3, 0)]))
    const codex = summarize(events).participants.backend.find(g => g.name === 'codex')!
    expect(codex.adjudicated).toBe(9)
    expect(codex.verdict).toBe('insufficient')
    const enough = summarize([...events, stage(70, [inv('codex', 1, 0)])]).participants.backend[0]
    expect(enough.verdict).toBe('keep')
    const fewRuns = summarize(Array.from({ length: 4 }, () => stage(70, [inv('codex', 5, 0)]))).participants.backend[0]
    expect(fewRuns).toMatchObject({ adjudicated: 20, runs: 4, verdict: 'insufficient' })
  })

  it('reports unknown, not 0%, when nothing is adjudicated', () => {
    const s = summarize([stage(70, [inv('codex', null, null, 'succeeded', ['frontend-design'])])])
    expect(s.participants.skill[0].contribution).toBeNull()
    expect(summaryLines('t', s, 0).join('\n')).toContain('contribution unknown')
  })

  it('revisits low contribution or high failure, and marks multi-skill attribution non-additive', () => {
    const low = Array.from({ length: 5 }, () => stage(70, [inv('agy', 1, 2, 'succeeded', ['a', 'b'])]))
    const s = summarize(low)
    expect(s.participants.backend[0]).toMatchObject({ contribution: 0.3333, verdict: 'revisit' })
    expect(s.participants.skill.map(g => g.non_additive)).toEqual([true, true])
    const failing = [...Array.from({ length: 5 }, () => stage(70, [inv('x', 3, 0)])), stage(70, [inv('x', null, null, 'failed')]), stage(70, [inv('x', null, null, 'failed')])]
    expect(summarize(failing).participants.backend[0]).toMatchObject({ failure_rate: 0.2857, verdict: 'revisit' })
  })
})

describe('calibration', () => {
  it('pairs only with later outcomes, never with the stage\'s own verify', () => {
    const a = stage(85)
    const b = stage(85)
    const s = summarize([a, b, outcome(a, 'review', 'failed', 2)])
    expect(s.calibration.unpaired).toEqual({ verify: 2, review: 1 })
    expect(s.calibration.review.find(r => r.band === 'High')).toMatchObject({ paired: 1, observed: 0, gap: 0.85 })
  })

  it('uses the earliest usable outcome per kind and excludes unknown', () => {
    const a = stage(60)
    const s = summarize([a, outcome(a, 'verify', 'unknown', null), outcome(a, 'verify', 'passed', null), outcome(a, 'verify', 'failed', null)])
    expect(s.calibration.verify.find(r => r.band === 'Medium')).toMatchObject({ paired: 1, observed: 1, gap: -0.4 })
  })
})

describe('P7: influence classes', () => {
  it('are exclusive and exhaustive over every small case, and reversal needs an initial choice', () => {
    const opts = ['a', 'b', 'c']
    const values = [null, ...opts]
    let total = 0
    for (const rec of values) {
      for (const init of values) {
        for (const final of opts) {
          const c = classify({ recommendation: rec, initial_choice: init, final_choice: final })
          total++
          if (c === 'reversed') expect(init !== null && init !== final && final === rec).toBe(true)
          if (init === null) expect(c).not.toBe('reversed')
          if (rec === null) expect(c).toBe('unknown')
        }
      }
    }
    expect(total).toBe(48)
  })

  it('flags rubber-stamp risk on 10 straight adoptions, or a high first-position rate', () => {
    const adopted = Array.from({ length: 10 }, () => decision(['a', 'b'], 'a', null, 'a'))
    const s = summarize(adopted)
    expect(s.influence.rubber_stamp).toEqual({ flag: true, basis: 'last 10 recommended decisions: 10 adopted, 0 overrode' })
    expect(summaryLines('t', s, 0).join('\n')).toContain('rubber-stamp risk')
    // The recommended option is listed second here, so the first-position rule does not fire either.
    const mixed = [...Array.from({ length: 9 }, () => decision(['b', 'a'], 'a', null, 'a')), decision(['b', 'a'], 'a', null, 'b')]
    expect(summarize(mixed).influence.rubber_stamp.flag).toBe(false)
    const firsts = Array.from({ length: 10 }, (_, i) => decision(['a', 'b'], null, null, i < 9 ? 'a' : 'b'))
    expect(summarize(firsts).influence.rubber_stamp).toEqual({ flag: true, basis: 'first option chosen 9/10' })
  })
})

describe('P5/P6: determinism and bounds', () => {
  function random(seed: number) {
    const rand = mulberry32(seed)
    const names = ['codex', 'agy', 'claude', 'ëxotic', '𝓧', 'zz']
    const out: LedgerEvent[] = []
    for (let i = 0; i < 300; i++) {
      const r = rand()
      if (r < 0.5) {
        out.push(stage(Math.floor(rand() * 96), [inv(names[Math.floor(rand() * names.length)], rand() < 0.2 ? null : Math.floor(rand() * 4), Math.floor(rand() * 3), rand() < 0.1 ? 'failed' : 'succeeded', [names[Math.floor(rand() * names.length)]])]))
      }
      else if (r < 0.7 && out.length) {
        const t = out.filter(e => e.kind === 'stage_completed')
        if (t.length) out.push(outcome(t[Math.floor(rand() * t.length)], rand() < 0.5 ? 'verify' : 'review', ['passed', 'failed', 'unknown'][Math.floor(rand() * 3)], rand() < 0.3 ? null : Math.floor(rand() * 3)))
      }
      else {
        out.push(decision(['a', 'b', 'c'], rand() < 0.2 ? null : 'a', rand() < 0.5 ? null : 'b', ['a', 'b', 'c'][Math.floor(rand() * 3)]))
      }
    }
    return out
  }

  it('is a pure function of the log, invariant under input order', () => {
    for (const seed of [1, 2, 3]) {
      const events = random(seed)
      const r = mulberry32(seed + 9)
      const shuffled = [...events]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      const rekeyed = shuffled.map(e => shuffleKeys(e, r) as LedgerEvent)
      expect(shuffled.map(e => e.seq)).not.toEqual(events.map(e => e.seq))
      expect(JSON.stringify(summarize(rekeyed))).toBe(JSON.stringify(summarize(events)))
    }
  })

  it('keeps every rate in [0,1] or null, with no NaN, and buckets summing to totals', () => {
    for (const seed of [4, 5, 6, 7]) {
      const s = summarize(random(seed))
      const json = JSON.stringify(s)
      expect(json).not.toMatch(/NaN|Infinity/)
      for (const kind of ['backend', 'skill', 'role'] as const) {
        for (const g of s.participants[kind]) {
          for (const r of [g.contribution, g.failure_rate]) if (r !== null) expect(r >= 0 && r <= 1).toBe(true)
          expect(g.adjudicated).toBe(g.accepted + g.rejected)
          expect(g.succeeded + g.failed + g.skipped).toBe(g.invoked)
        }
      }
      const c = s.influence.classes
      expect(c.adopted + c.reversed + c.overrode + c.unknown).toBe(s.influence.decisions)
    }
    expect(summarize([])).toMatchObject({ events: 0, influence: { decisions: 0, first_position: { rate: null } } })
  })

  it('stays within line and byte caps with 5,000 groups, without splitting UTF-8, while totals count all', () => {
    const events = Array.from({ length: 5000 }, (_, i) => stage(70, [inv('codex', 1, 0, 'succeeded', [`skill-é-${i}`])]))
    const s = summarize(events)
    expect(s.participants.skill).toHaveLength(5000)
    const text = bound(summaryLines('t', s, 0), parseBounds(undefined, undefined))
    expect(text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(40)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192)
    expect(text).toMatch(/… \+\d+ more; run with --limit\/--json\n$/)
    const tiny = bound(['é'.repeat(2000), 'b'], parseBounds(5, 512))
    expect(Buffer.byteLength(tiny)).toBeLessThanOrEqual(512)
    expect(tiny).not.toContain('�')
    expect(() => parseBounds(0, undefined)).toThrow(/--limit/)
    expect(() => parseBounds(undefined, 100)).toThrow(/--max-bytes/)
  })
})
