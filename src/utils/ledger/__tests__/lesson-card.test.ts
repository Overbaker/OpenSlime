import type { LedgerEvent } from '../schema'
import { describe, expect, it } from 'vitest'
import { cardLines, lessonCard } from '../lessons'
import { probeResult } from '../probe'
import { mulberry32 } from './fixtures'
import { inv, probe, stage } from './events'

const win = { verify: 'passed', c: 0, w: 0 }
const lose = { verify: 'passed', c: 2, w: 0 }
const same = { verify: 'passed', c: 1, w: 0 }

describe('lesson card', () => {
  it('shows an untested backend', () => {
    const events = [
      stage(70, [inv('codex', 1, 0), inv('antigravity', 1, 0)]),
      probe(win, lose, { writer: { backend: 'codex', role: 'builder', model: null }, change_kind: 'feature' }),
      probe(win, lose, { writer: { backend: 'codex', role: 'builder', model: null } }),
    ]
    const lines = cardLines(lessonCard(events, 'project', 'L-0001'))
    expect(lines[0]).toBe('evidence from: backend codex ×2 · model (unknown) ×2 · role builder ×2 · change kind (unknown) ×1, feature ×1')
    expect(lines[1]).toContain('untested on: backend antigravity, claude')
    expect(lines[1]).toContain('role reviewer')
  })

  it('falls back to the change kind of the change and lists not-credited probes apart', () => {
    const events = [
      stage(70, [], { change_id: 'c9', payload: { status: 'completed', confidence: { percent: 70, band: 'Medium' }, verify: 'passed', invocations: [], change_kind: 'fix' } } as any),
      probe(win, lose, {}, { change_id: 'c9' }),
      probe({ verify: 'error', c: 0, w: 0 }, lose),
      probe(same, same, { interdiff_lines: 0 }),
    ]
    const c = lessonCard(events, 'project', 'L-0001')
    expect(c.evidence['change kind'].get('fix')).toBe(1)
    expect(cardLines(c).at(-1)).toBe('also seen (not credited): inert 1 · void 1 · confounded 0')
  })

  it('Q14: evidence and untested are disjoint and evidence comes only from credited probes', () => {
    const rand = mulberry32(14)
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
    const sides = [win, lose, same, { verify: 'failed', c: 0, w: 0 }]
    for (let t = 0; t < 100; t++) {
      const events: LedgerEvent[] = []
      for (let i = 0; i < 20; i++) {
        if (rand() < 0.5) {
          events.push(stage(70, [{ ...inv(pick(['codex', 'antigravity', 'x']), 1, 0, 'succeeded', [], pick(['builder', 'reviewer'])), model: pick(['m1', 'm2']) }], { payload: undefined } as any))
          events[events.length - 1].payload = { status: 'completed', confidence: { percent: 70, band: 'Medium' }, verify: 'passed', invocations: events[events.length - 1].payload?.invocations ?? [{ ...inv(pick(['codex', 'x']), 1, 0), model: pick(['m1', 'm2']) }], change_kind: pick(['feature', 'fix', undefined]) }
        }
        else {
          events.push(probe(pick(sides), pick(sides), { writer: rand() < 0.7 ? { backend: pick(['codex', 'antigravity', 'claude', 'y']), role: pick(['builder', 'reviewer']), model: pick(['m1', 'm3', null]) } : undefined, interdiff_lines: rand() < 0.2 ? 0 : 5 }))
        }
      }
      const c = lessonCard(events, 'project', 'L-0001')
      const credited = events.filter(e => e.kind === 'probe' && ['win', 'loss', 'severe_loss', 'tie'].includes(probeResult(e.payload as any))).length
      for (const axis of ['backend', 'model', 'role', 'change kind'] as const) {
        for (const v of c.untested[axis]) expect(c.evidence[axis].has(v)).toBe(false)
        expect([...c.evidence[axis].values()].reduce((s, n) => s + n, 0)).toBe(credited)
      }
    }
  })

  it('caps each axis at 5 names', () => {
    const events = Array.from({ length: 8 }, (_, i) => stage(70, [inv(`b${i}`, 1, 0)]))
    expect(cardLines(lessonCard(events, 'project', 'L-0001'))[1]).toMatch(/backend (\S+, ){4}\S+ \+6 more/)
  })
})
