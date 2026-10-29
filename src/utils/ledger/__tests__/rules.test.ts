import { describe, expect, it } from 'vitest'
import { probeResult } from '../probe'
import { cohorts, cohortView, evaluateRules } from '../rules'
import { summarize } from '../summary'
import { cohortLines } from '../render'
import { decision, ev, inv, outcome, probe, stage } from './events'

const ruleState = (events: any[], id: string) => evaluateRules(events).find(r => r.id === id)!

describe('probe result (used by H-0003 and the summary)', () => {
  it('P8: swapping sides flips win and loss and leaves the rest unchanged', () => {
    const sides = [{ verify: 'passed', c: 0, w: 0 }, { verify: 'passed', c: 1, w: 0 }, { verify: 'failed', c: 0, w: 2 }, { verify: 'passed', c: 0, w: 3 }]
    const flip: Record<string, string> = { win: 'loss', loss: 'win', severe_loss: 'win', tie: 'tie' }
    for (const a of sides) {
      for (const b of sides) {
        const r = probeResult(probe(a, b).payload as any)
        const s = probeResult(probe(b, a).payload as any)
        const moved = probe(a, b)
        moved.payload.candidates = [...moved.payload.candidates].reverse().map((c: any, i: number) => ({ ...c, label: i ? 'B' : 'A' }))
        expect(probeResult(moved.payload as any)).toBe(r)
        if (r === 'severe_loss') expect(s).toBe('win')
        else if (s === 'severe_loss') expect(r).toBe('win')
        else expect(s).toBe(flip[r])
      }
    }
  })

  it('P9: diff size never changes the result; P10: fingerprint mismatch is confounded', () => {
    const p = probe({ verify: 'passed', c: 0, w: 0 }, { verify: 'passed', c: 0, w: 0 })
    p.payload.candidates[1].diff_lines = 1
    p.payload.candidates[0].diff_lines = 900
    expect(probeResult(p.payload as any)).toBe('tie')
    p.payload.candidates[1].fingerprint = 'other'
    expect(probeResult(p.payload as any)).toBe('confounded')
    expect(probeResult(probe({ verify: 'passed', c: 0, w: 0 }, { verify: 'passed', c: 1, w: 0 }, { interdiff_lines: 0 }).payload as any)).toBe('inert')
    expect(probeResult(probe({ verify: 'error', c: 0, w: 0 }, { verify: 'passed', c: 0, w: 0 }).payload as any)).toBe('void')
    const failingLessonOnA = probe({ verify: 'failed', c: 0, w: 0 }, { verify: 'passed', c: 0, w: 0 })
    failingLessonOnA.payload.candidates.reverse()
    expect(probeResult(failingLessonOnA.payload as any)).toBe('severe_loss')
  })
})

describe('H-rules', () => {
  it('start adopted with no evidence', () => {
    expect(evaluateRules([]).map(r => r.state)).toEqual(['adopted', 'adopted', 'adopted', 'adopted', 'adopted'])
  })

  it('H-0001 revisits on a calibration gap > 0.15 with n ≥ 20, not before', () => {
    const make = (n: number) => {
      const out: any[] = []
      for (let i = 0; i < n; i++) {
        const s = stage(90)
        out.push(s, outcome(s, 'review', 'failed', 1))
      }
      return out
    }
    expect(ruleState(make(19), 'H-0001').state).toBe('adopted')
    expect(ruleState(make(20), 'H-0001')).toMatchObject({ state: 'revisit', evidence: 'calibration gap 0.9 at review/High (n=20)' })
  })

  it('H-0003 revisits when budget skips exceed credited probes over ≥ 20 opportunities', () => {
    const skip = () => ev('probe', { lesson_id: 'L-0001', lesson_scope: 'project', mode: 'lesson', skip_reason: 'budget', candidates: [], interdiff_lines: null, ab_map_recorded_after_reviews: null, landed: null, forced: false })
    const events = [...Array.from({ length: 12 }, skip), ...Array.from({ length: 8 }, () => probe({ verify: 'passed', c: 0, w: 0 }, { verify: 'passed', c: 1, w: 0 }))]
    expect(ruleState(events, 'H-0003')).toMatchObject({ state: 'revisit', evidence: 'budget skips 12 > credited 8 (n=20)' })
    expect(ruleState(events.slice(1), 'H-0003').state).toBe('adopted')
  })

  it('H-0004 revisits when blind picks disagree in ≥ 50% of ≥ 6 cases', () => {
    const opts = ['with-lesson', 'without-lesson', 'cant-tell']
    const picks = [...Array.from({ length: 3 }, () => decision(opts, null, null, 'with-lesson', true)), ...Array.from({ length: 3 }, () => decision(opts, null, null, 'cant-tell', true))]
    expect(ruleState(picks, 'H-0004')).toMatchObject({ state: 'revisit', evidence: 'blind picks disagree 3/6' })
    expect(ruleState(picks.slice(1), 'H-0004').state).toBe('adopted')
  })

  it('H-0002 and H-0005 follow their thresholds', () => {
    const tally = { W: 4, L: 0, T: 0, inert: 0, void: 0, changes_with_wins: 2, severe_losses: 0 }
    const st = (id: string, from: any, to: string, reason = 'x') => ev('lesson_state', { lesson_id: id, scope: 'project', from, to, reason, tally }, { stage: 'lesson' })
    const states = ['L-1', 'L-2', 'L-3', 'L-4', 'L-5'].map(id => st(id, 'trial', 'adopted'))
    expect(ruleState([...states, st('L-1', 'adopted', 'retired', 'critical: F1')], 'H-0002').state).toBe('adopted')
    expect(ruleState([...states, st('L-1', 'adopted', 'retired', 'critical: F1'), st('L-2', 'adopted', 'retired', 'critical: F2')], 'H-0002').state).toBe('revisit')
    const other = ['L-1', 'L-2', 'L-3', 'L-4', 'L-5'].map(id => ({ ...st(id, 'trial', 'adopted'), project_id: 'p_bbbbbbbbbbbbbbbb' }))
    expect(ruleState([...states, ...other, st('L-1', 'adopted', 'retired', 'critical: F1'), st('L-2', 'adopted', 'retired', 'critical: F2')], 'H-0002')).toMatchObject({ state: 'adopted', evidence: '2/10 adopted lessons retired for a Critical' })
    const weak = Array.from({ length: 5 }, () => stage(70, [inv('codex', 1, 2)]))
    expect(ruleState(weak, 'H-0005')).toMatchObject({ state: 'revisit', evidence: 'reviewer contribution 0.3333 (n=15)' })
  })

  it('P17: rule state is a pure function of the log', () => {
    const events = [stage(90), decision(['a', 'b'], 'a', null, 'a'), probe({ verify: 'passed', c: 0, w: 0 }, { verify: 'passed', c: 1, w: 0 })]
    expect(evaluateRules(events)).toEqual(evaluateRules([...events].reverse()))
  })

})

describe('cohorts (--by-harness)', () => {
  const h = (install: string, files: Record<string, string>) => ({ harness: { version: 't', digest: 'd', install, files, params: 'p' } })

  it('groups by install digest, names changed files, and marks small cohorts insufficient', () => {
    const v1 = { '.ccg/prompts/codex/reviewer.md': 'aaa', 'commands/osm/review.md': 'bbb' }
    const v2 = { ...v1, '.ccg/prompts/codex/reviewer.md': 'ccc' }
    const events: any[] = []
    for (let i = 0; i < 6; i++) {
      const s = stage(80, [], h('i1', v1))
      events.push(s, outcome(s, 'review', 'failed', 1, h('i1', v1)))
    }
    for (let i = 0; i < 2; i++) events.push(stage(80, [], h('i2', v2)))
    const { cohorts: cs, omitted } = cohorts(events)
    expect(omitted).toBe(0)
    expect(cs.map(c => c.install)).toEqual(['i1', 'i2'])
    expect(cs[0]).toMatchObject({ events: 12, changed: [], later_critical: { rate: 1, n: 6 }, calibration_gap: { review: 0.8, review_n: 6 } })
    expect(cs[1]).toMatchObject({ changed: ['.ccg/prompts/codex/reviewer.md'], later_critical: { rate: null, n: 0 } })
  })

  it('stage mix does not split a cohort, and only the last 5 cohorts are shown', () => {
    const events = [stage(70, [], { stage: 'plan', ...h('i1', {}) }), stage(70, [], { stage: 'review', ...h('i1', {}) })]
    expect(cohorts(events).cohorts).toHaveLength(1)
    const many = Array.from({ length: 7 }, (_, i) => stage(70, [], h(`i${i}`, {})))
    expect(cohorts(many)).toMatchObject({ omitted: 2 })
    expect(cohorts(many).cohorts.map(c => c.install)).toEqual(['i2', 'i3', 'i4', 'i5', 'i6'])
  })
})

describe('review fixes', () => {
  const h = (install: string) => ({ harness: { version: 't', digest: 'd', install, files: {}, params: 'p' } })

  it('credits an outcome to the cohort of the stage it targets, not the install it was recorded under', () => {
    const events: any[] = []
    const stages = Array.from({ length: 12 }, () => stage(70, [], h('I1')))
    events.push(...stages, ...stages.map(st => outcome(st, 'review', 'failed', 1, h('I2'))))
    expect(cohortView(events, 'I2')).toHaveLength(0)
    expect(cohortView(events, 'I1')).toHaveLength(24)
    expect(evaluateRules(cohortView(events, 'I2')).find(r => r.id === 'H-0005')!.state).toBe('adopted')
    expect(evaluateRules(cohortView(events, 'I1')).find(r => r.id === 'H-0005')!.state).toBe('revisit')
  })

  it('folds a merged view in the loader\'s renumbered order', () => {
    const old = Array.from({ length: 12 }, (_, i) => decision(['a', 'b'], 'a', null, 'b', false, { project_id: 'p_aaaaaaaaaaaaaaaa', seq: i + 1 }))
    const recent = Array.from({ length: 10 }, (_, i) => decision(['b', 'a'], 'a', null, 'a', false, { project_id: 'p_bbbbbbbbbbbbbbbb', seq: 13 + i }))
    expect(summarize([...recent, ...old]).influence.rubber_stamp.flag).toBe(true)
    const a = stage(70, [], { seq: 1, ...h('OLD') })
    const b = stage(70, [], { seq: 2, ...h('NEW') })
    expect(cohorts([b, a]).cohorts.map(c => c.install)).toEqual(['OLD', 'NEW'])
  })

  it('shows "not observed in shared files" on the first shown cohort only when older ones were omitted', () => {
    const c = cohorts([stage(70, [], h('X'))]).cohorts
    expect(cohortLines(c, 1)[1]).toContain('changed: not observed in shared files')
    expect(cohortLines(c, 0)[1]).not.toContain('not observed')
  })

})
