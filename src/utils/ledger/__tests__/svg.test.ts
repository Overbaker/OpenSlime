import type { LedgerEvent } from '../schema'
import { describe, expect, it } from 'vitest'
import { lintSvg } from '../../svg-lint'
import { decisionView, dimensionView } from '../dimensions'
import { cutName, renderSvg, shown } from '../svg'
import { decision, inv, outcome, stage } from './events'

function data(events: LedgerEvent[]) {
  return { label: 'project abcdef', events: events.length, runs: 3, changes: 1, first: '2026-10-01', last: '2026-10-30', view: dimensionView(events, 'skill'), decisions: decisionView(events), position: { first: 2, n: 12, excluded: 3 } }
}

describe('Q15: render', () => {
  it('passes the lint in both themes, states n and dates, and escapes adversarial names', () => {
    const evil = '</text><script>alert(1)</script>&"\'' + 'x'.repeat(80)
    const events: LedgerEvent[] = []
    for (let i = 0; i < 20; i++) {
      const s = stage(70, [inv('codex', null, null, 'succeeded', i < 10 ? [evil] : [])], { run_id: `r${i % 10 < 5 ? i : i}` })
      events.push(s, outcome(s, 'review', 'failed', i < 10 ? 1 : 0))
    }
    events.push(decision(['a', 'b'], 'a', null, 'a'))
    for (const theme of ['light', 'dark'] as const) {
      const svg = renderSvg(data(events), theme)
      expect(lintSvg(svg), theme).toEqual([])
      expect(svg).toContain('n = 41 events · 3 runs · 1 changes · data: 2026-10-01 – 2026-10-30')
      expect(svg).toContain('associated-worse')
      expect(svg).not.toContain('<script>')
      expect(svg).toContain('associations, not causes · verdicts never change OpenSlime')
      expect(svg).toContain('chose the first-shown option: 2 of 12 randomized decisions (not randomized: 3)')
      expect(renderSvg(data(events), theme)).toBe(svg)
    }
    expect([...cutName(evil)].length).toBeLessThanOrEqual(32)
    expect([...cutName('漢'.repeat(40))].length).toBeLessThanOrEqual(19)
  })

  it('hides path-like names and the hidden repo name, and keeps server:tool names', () => {
    const events: LedgerEvent[] = []
    for (let i = 0; i < 20; i++) {
      const s = stage(70, [inv('codex', null, null, 'succeeded', i < 10 ? ['/home/u/secret-skill', 'zqrepo', 'javascript:lint', 'a/b/c'] : ['context7:query-docs', 'deepseek/deepseek-chat'])], { run_id: `r${i}` })
      events.push(s, outcome(s, 'review', 'failed', i < 10 ? 1 : 0))
    }
    const svg = renderSvg({ ...data(events), hide: ['zqrepo'] }, 'light')
    expect(svg).not.toContain('secret-skill')
    expect(svg).not.toContain('zqrepo')
    expect(svg).toContain('(hidden)')
    expect(svg).toContain('context7:query-docs')
    const model: LedgerEvent[] = []
    for (let i = 0; i < 20; i++) {
      const st = stage(70, [{ ...inv('opencode', null, null), model: i < 10 ? 'deepseek/deepseek-chat' : 'other' }], { run_id: `m${i}` })
      model.push(st, outcome(st, 'review', 'failed', i < 10 ? 1 : 0))
    }
    expect(renderSvg({ ...data(model), view: dimensionView(model, 'model') }, 'dark')).toContain('deepseek/deepseek-chat')
    expect(svg).not.toContain('javascript:')
    expect(svg).not.toContain('a/b/c')
    expect(shown('foreignObject-helper', [])).toBe('(hidden)')
    expect(shown('x style=1', [])).toBe('(hidden)')
    expect(shown('on\u0000load=1', [])).toBe('(hidden)')
    expect(shown('zqrepo-mcp:query', ['zqrepo'])).toBe('(hidden)')
    expect(shown('db', ['db'])).toBe('(hidden)')
    expect(shown('dbx', ['db'])).toBe('dbx')
    expect(lintSvg(svg)).toEqual([])
  })

  it('shows USD next to tokens in the cost panel', () => {
    const events: LedgerEvent[] = []
    for (let i = 0; i < 20; i++) {
      const st = stage(70, [{ ...inv('codex', null, null, 'succeeded', i < 10 ? ['s'] : []), cost: { tokens: null, usd: i < 10 ? 0.05 : 0.01 } }], { run_id: `c${i}` })
      events.push(st, outcome(st, 'review', 'failed', 0))
    }
    expect(renderSvg(data(events), 'light')).toContain('with unknown tokens $0.0500 (n=10)')
  })

  it('says when there are not enough randomized decisions', () => {
    const d = { ...data([]), position: { first: 0, n: 4, excluded: 9 } }
    const svg = renderSvg(d, 'light')
    expect(svg).toContain('not enough randomized decisions')
    expect(lintSvg(svg)).toEqual([])
  })
})
