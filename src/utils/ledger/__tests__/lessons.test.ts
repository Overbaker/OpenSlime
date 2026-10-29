import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { addLesson, adoptLesson, autoRetire, effectiveState, lessonsDir, parseLesson, promoteLesson, queryLessons, queryLine, readLessons, retireLesson, serializeLesson } from '../lessons'
import { summarize } from '../summary'
import { projectLog } from '../paths'
import { resolveProject } from '../project'
import { appendEvent, readLog } from '../store'
import { validateInput } from '../schema'
import { decisionEvent, mulberry32, probeEvent, stageEvent, tmp } from './fixtures'

function setup(name = 'proj', base = tmp()) {
  const projectRoot = join(base, name)
  mkdirSync(join(projectRoot, 'openspec'), { recursive: true })
  const root = join(base, 'ledger')
  const opts = { root, installDir: join(base, 'claude'), projectRoot, version: 't', env: {} }
  const lopts = { ...opts, runId: 'run-lesson' }
  const project = resolveProject(projectRoot)
  const events = () => readLog(projectLog(root, project.id)).events
  const evidence = (appendEvent(stageEvent({ operation_key: `seed-${name}` }), opts) as any).receipt.event_id as string
  return { base, root, opts, lopts, project, events, evidence }
}

const lessonInput = (evidence: string, over: Record<string, unknown> = {}) => ({
  line: 'Before changing a parser, add a failing test for empty input.',
  cue: 'changing a parser',
  match: { globs: ['src/**/parser*.ts'], kind: 'backend', keywords: ['parser'] },
  evidence: [evidence],
  created_from: 'review finding F1',
  ...over,
})

function probeFor(id: string, n: number, change: string, result: 'win' | 'loss' | 'severe' | 'inert' | 'tie', scope = 'project') {
  const lesson = { label: 'B', has_lesson: true, fingerprint: 'f', verify: 'passed', critical_confirmed: 0, warning_confirmed: 0, diff_lines: 5 }
  const base = { label: 'A', has_lesson: false, fingerprint: 'f', verify: 'passed', critical_confirmed: 0, warning_confirmed: 0, diff_lines: 5 }
  if (result === 'win') base.critical_confirmed = 1
  if (result === 'loss') lesson.critical_confirmed = 1
  if (result === 'severe') lesson.verify = 'failed'
  const p = probeEvent({ operation_key: `probe-${id}-${n}`, change_id: change })
  p.payload = { ...p.payload, lesson_id: id, lesson_scope: scope, candidates: [base, lesson], interdiff_lines: result === 'inert' ? 0 : 4 }
  return p
}

function recordProbe(s: ReturnType<typeof setup>, p: any) {
  return appendEvent(p, { ...s.opts, after: ctx => autoRetire(ctx, validateInput(p), p.run_id) })
}

function reveal(s: ReturnType<typeof setup>, id: string, choice = 'adopt') {
  const d = decisionEvent({ stage: 'impl', phase_id: '1', operation_key: `reveal-${id}-${choice}`, payload: { decision_id: `reveal-${id}`, topic: `Adopt ${id}?`, options: ['adopt', 'keep-trial', 'retire'], recommendation: null, initial_choice: null, final_choice: choice, final_position: ['adopt', 'keep-trial', 'retire'].indexOf(choice), blind: false } })
  return (appendEvent(d, s.opts) as any).receipt.event_id as string
}

describe('lesson entries', () => {
  it('round-trips through the front-matter format', () => {
    const l = { id: 'L-0001', scope: 'project', state: 'trial', slot: 'brief', line: 'a: "b"', cue: 'c', match: { globs: [], kind: 'any', keywords: [] }, evidence: ['e'], contradicts: [], created_from: 'user', promoted_from: null, revision: 1, body: 'why\nmore' } as any
    expect(parseLesson(serializeLesson(l))).toEqual(l)
  })

  it('rejects missing or unknown evidence and writes nothing', () => {
    const s = setup()
    expect(addLesson(lessonInput(s.evidence, { evidence: [] }), s.lopts).code).toBe(2)
    expect(addLesson(lessonInput(s.evidence, { evidence: ['nope'] }), s.lopts).code).toBe(2)
    expect(addLesson(lessonInput(s.evidence, { line: 'a\nb' }), s.lopts).code).toBe(2)
    expect(readLessons(lessonsDir(s.root, 'project', s.project.id))).toHaveLength(0)
  })

  it('moves a new lesson to trial, but keeps a duplicate line as candidate', () => {
    const s = setup()
    expect(addLesson(lessonInput(s.evidence), s.lopts)).toMatchObject({ code: 0, data: { id: 'L-0001', state: 'trial' } })
    expect(addLesson(lessonInput(s.evidence, { cue: 'other' }), s.lopts)).toMatchObject({ code: 0, data: { id: 'L-0002', state: 'candidate' } })
    const states = s.events().filter(e => e.kind === 'lesson_state').map(e => `${e.payload.lesson_id}:${e.payload.from}->${e.payload.to}`)
    expect(states).toEqual(['L-0001:null->candidate', 'L-0001:candidate->trial', 'L-0002:null->candidate'])
  })

  it('rebuilds INDEX from entries', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    const dir = lessonsDir(s.root, 'project', s.project.id)
    const before = readFileSync(join(dir, 'INDEX.md'), 'utf8')
    rmSync(join(dir, 'INDEX.md'))
    retireLesson('L-0001', 'project', 'x', s.lopts)
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe('')
    expect(before).toMatch(/^L-0001 trial project "Before changing a parser/)
  })
})

describe('P11: lifecycle legality and thresholds', () => {
  it('refuses adoption below the bar, then adopts at W≥4, W−L≥3 over 2 changes with a reveal decision', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    for (let i = 0; i < 3; i++) recordProbe(s, probeFor('L-0001', i, i < 2 ? 'c1' : 'c2', 'win'))
    const d = reveal(s, 'L-0001')
    expect(adoptLesson('L-0001', 'project', d, s.lopts)).toMatchObject({ code: 2, message: expect.stringMatching(/below the adoption bar: W3/) })
    expect(effectiveState(s.events(), 'project', 'L-0001', null)).toBe('trial')
    recordProbe(s, probeFor('L-0001', 3, 'c2', 'win'))
    expect(adoptLesson('L-0001', 'project', 'missing', s.lopts).code).toBe(2)
    const blind = decisionEvent({ operation_key: 'blind', payload: { decision_id: 'reveal-L-0001', topic: 'which', options: ['adopt', 'x'], recommendation: null, initial_choice: null, final_choice: 'adopt', final_position: 0, blind: true } })
    expect(adoptLesson('L-0001', 'project', (appendEvent(blind, s.opts) as any).receipt.event_id, s.lopts).message).toMatch(/blind pick cannot adopt/)
    expect(adoptLesson('L-0001', 'project', reveal(s, 'L-0001', 'keep-trial'), s.lopts).message).toMatch(/final_choice is keep-trial/)
    expect(adoptLesson('L-0001', 'project', d, s.lopts)).toMatchObject({ code: 0, data: { state: 'adopted' } })
    expect(adoptLesson('L-0001', 'project', d, s.lopts)).toMatchObject({ code: 0, message: 'L-0001 already adopted' })
  })

  it('a severe loss blocks adoption even with enough wins', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    ;['win', 'win', 'win', 'win', 'win', 'severe'].forEach((r, i) => recordProbe(s, probeFor('L-0001', i, `c${i % 2}`, r as any)))
    expect(adoptLesson('L-0001', 'project', reveal(s, 'L-0001'), s.lopts).message).toMatch(/severe 1/)
  })

  it('retires automatically in the same locked append when L−W reaches 2', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    recordProbe(s, probeFor('L-0001', 0, 'c1', 'loss'))
    expect(effectiveState(s.events(), 'project', 'L-0001', null)).toBe('trial')
    recordProbe(s, probeFor('L-0001', 1, 'c1', 'loss'))
    const last = s.events().at(-1)!
    expect(last).toMatchObject({ kind: 'lesson_state', payload: { from: 'trial', to: 'retired', reason: 'auto: L−W=2' } })
    expect(readFileSync(join(lessonsDir(s.root, 'project', s.project.id), 'INDEX.md'), 'utf8')).toBe('')
    expect(queryLessons(s.root, s.project.id, s.events(), { files: [], kind: 'any', text: '', scope: 'both', limit: 5, all: false }).rows).toHaveLength(0)
  })

  it('retires after 3 inert results among the first 5 probes', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    ;['inert', 'tie', 'inert', 'inert'].forEach((r, i) => recordProbe(s, probeFor('L-0001', i, 'c1', r as any)))
    expect(s.events().at(-1)!.payload).toMatchObject({ to: 'retired', reason: 'auto: 3 of the first 5 probes inert' })
  })

  it('state is a pure fold: random transition sequences never produce an illegal state', () => {
    for (const seed of [1, 2, 3]) {
      const s = setup(`p${seed}`)
      addLesson(lessonInput(s.evidence), s.lopts)
      const rand = mulberry32(seed)
      for (let i = 0; i < 25; i++) {
        const r = rand()
        if (r < 0.6) recordProbe(s, probeFor('L-0001', i, `c${i % 3}`, (['win', 'loss', 'tie', 'inert', 'win'] as const)[Math.floor(rand() * 5)]))
        else if (r < 0.8) adoptLesson('L-0001', 'project', reveal(s, 'L-0001'), s.lopts)
        else retireLesson('L-0001', 'project', 'random', s.lopts)
      }
      const transitions = s.events().filter(e => e.kind === 'lesson_state').map(e => [e.payload.from, e.payload.to])
      const legal = new Set(['null,candidate', 'candidate,trial', 'trial,adopted', 'trial,retired', 'adopted,retired', 'candidate,retired'])
      for (const t of transitions) expect(legal.has(`${t[0]},${t[1]}`)).toBe(true)
      for (let i = 1; i < transitions.length; i++) expect(transitions[i][0]).toBe(transitions[i - 1][1])
      const adopted = s.events().filter(e => e.kind === 'lesson_state' && e.payload.to === 'adopted')
      for (const a of adopted) expect(a.payload.tally.W >= 4 && a.payload.tally.W - a.payload.tally.L >= 3).toBe(true)
    }
  })
})

describe('P12: bounded query', () => {
  it('returns at most `limit` lines of ≤200 chars from 10,000 entries, and finds a lesson missing from a stale INDEX', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    const dir = lessonsDir(s.root, 'project', s.project.id)
    const template = readLessons(dir)[0]
    for (let i = 2; i <= 10_000; i++) writeFileSync(join(dir, 'entries', `L-${String(i).padStart(5, '0')}.md`), serializeLesson({ ...template, id: `L-${String(i).padStart(5, '0')}`, line: `rule ${i} ${'x'.repeat(300)}`, cue: 'é'.repeat(150) }))
    writeFileSync(join(dir, 'INDEX.md'), '')
    const q = { files: ['src/a/parser.ts'], kind: 'backend' as const, text: 'fix parser', scope: 'both' as const, limit: 5, all: true }
    const { rows, matched } = queryLessons(s.root, s.project.id, s.events(), q)
    expect(rows).toHaveLength(5)
    expect(matched).toBe(10_000)
    expect(rows[0].lesson.id).toBe('L-0001')
  }, 60_000)

  it('orders adopted before trial and project before global, and marks cue conflicts', () => {
    const base = tmp()
    const a = setup('a', base)
    addLesson(lessonInput(a.evidence), a.lopts)
    ;[0, 1, 2, 3].forEach(i => recordProbe(a, probeFor('L-0001', i, `c${i % 2}`, 'win')))
    adoptLesson('L-0001', 'project', reveal(a, 'L-0001'), a.lopts)
    const promo = decisionEvent({ operation_key: 'promo', payload: { decision_id: 'promote-L-0001', topic: 'promote?', options: ['promote', 'keep'], recommendation: null, initial_choice: null, final_choice: 'promote', final_position: 0, blind: false } })
    expect(promoteLesson('L-0001', (appendEvent(promo, a.opts) as any).receipt.event_id, a.lopts)).toMatchObject({ code: 0, data: { id: 'L-0001' } })

    const b = setup('b', base)
    const q = { files: [], kind: 'backend' as any, text: '', scope: 'both' as const, limit: 5, all: false }
    const inB = queryLessons(b.root, b.project.id, b.events(), q).rows
    expect(inB.map(r => [r.lesson.scope, r.state])).toEqual([['global', 'trial']])
    addLesson(lessonInput(b.evidence, { line: 'A different rule for parsers.' }), b.lopts)
    const both = queryLessons(b.root, b.project.id, b.events(), q).rows
    expect(both.map(r => [r.lesson.scope, r.conflict])).toEqual([['project', true], ['global', true]])
    const inA = queryLessons(a.root, a.project.id, a.events(), q).rows
    expect(inA.map(r => [r.lesson.scope, r.state])).toEqual([['project', 'adopted'], ['global', 'trial']])
  })
})

describe('review fixes', () => {
  const q = (over: Record<string, unknown> = {}) => ({ files: [] as string[], kind: 'backend' as any, text: '', scope: 'both' as const, limit: 5, all: false, ...over })

  it('rejects absolute paths in lesson text and in the retire reason, with exit 2', () => {
    const s = setup()
    for (const over of [{ line: 'Read /home/alice/.ssh/config first' }, { cue: 'see C:\\Users\\a' }, { created_from: '/home/alice/notes' }, { body: 'from /Users/bob/x' }, { match: { globs: ['/home/a/**'], kind: 'any', keywords: [] } }]) {
      expect(addLesson(lessonInput(s.evidence, over), s.lopts).code).toBe(2)
    }
    addLesson(lessonInput(s.evidence), s.lopts)
    expect(retireLesson('L-0001', 'project', 'see /home/alice/x', s.lopts).code).toBe(2)
  })

  it('matches kind only when equal or the lesson says any', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence, { match: { globs: ['server/**'], kind: 'backend', keywords: ['database'] } }), s.lopts)
    const ev = s.events()
    expect(queryLessons(s.root, s.project.id, ev, q({ kind: 'any', files: ['web/a.tsx'], text: 'css' })).rows).toHaveLength(0)
    expect(queryLessons(s.root, s.project.id, ev, q({ kind: 'frontend' })).rows).toHaveLength(0)
    expect(queryLessons(s.root, s.project.id, ev, q({ kind: 'any', files: ['server/db.ts'] })).rows).toHaveLength(1)
  })

  it('matches **/name on a path-segment boundary', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence, { match: { globs: ['**/parser.ts'], kind: 'frontend', keywords: [] } }), s.lopts)
    expect(queryLessons(s.root, s.project.id, s.events(), q({ files: ['src/myparser.ts'] })).rows).toHaveLength(0)
    expect(queryLessons(s.root, s.project.id, s.events(), q({ files: ['src/parser.ts'] })).rows).toHaveLength(1)
    expect(queryLessons(s.root, s.project.id, s.events(), q({ files: ['parser.ts'] })).rows).toHaveLength(1)
    addLesson(lessonInput(s.evidence, { line: 'Brace rule.', match: { globs: ['web/**/*.{ts,tsx}'], kind: 'frontend', keywords: [] } }), s.lopts)
    expect(queryLessons(s.root, s.project.id, s.events(), q({ files: ['web/a/b.tsx'] })).rows.map(r => r.lesson.line)).toEqual(['Brace rule.'])
    expect(queryLessons(s.root, s.project.id, s.events(), q({ files: ['web/a/b.js'] })).rows).toHaveLength(0)
  })

  it('does not count wins with a null change_id as a distinct change', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    for (let i = 0; i < 3; i++) recordProbe(s, probeFor('L-0001', i, null as any, 'win'))
    recordProbe(s, probeFor('L-0001', 3, 'c1', 'win'))
    expect(adoptLesson('L-0001', 'project', reveal(s, 'L-0001'), s.lopts).message).toMatch(/changes_with_wins 1/)
  })

  it('needs a scoped reveal decision for a global lesson', () => {
    const base = tmp()
    const a = setup('a', base)
    addLesson(lessonInput(a.evidence), a.lopts)
    ;[0, 1, 2, 3].forEach(i => recordProbe(a, probeFor('L-0001', i, `c${i % 2}`, 'win')))
    adoptLesson('L-0001', 'project', reveal(a, 'L-0001'), a.lopts)
    const promo = decisionEvent({ operation_key: 'promo', payload: { decision_id: 'promote-L-0001', topic: 'promote?', options: ['promote', 'keep'], recommendation: null, initial_choice: null, final_choice: 'promote', final_position: 0, blind: false } })
    promoteLesson('L-0001', (appendEvent(promo, a.opts) as any).receipt.event_id, a.lopts)
    const b = setup('b', base)
    addLesson(lessonInput(b.evidence, { line: 'Project rule.', cue: 'x' }), b.lopts)
    ;[0, 1].forEach(i => recordProbe(b, probeFor('L-0001', 10 + i, 'c1', 'win', 'global')))
    const projectReveal = reveal(b, 'L-0001')
    expect(adoptLesson('L-0001', 'global', projectReveal, b.lopts).message).toMatch(/decision_id must be reveal-global-L-0001/)
    const g = decisionEvent({ operation_key: 'rg', payload: { decision_id: 'reveal-global-L-0001', topic: 'adopt global?', options: ['adopt', 'keep-trial'], recommendation: null, initial_choice: null, final_choice: 'adopt', final_position: 0, blind: false } })
    expect(adoptLesson('L-0001', 'global', (appendEvent(g, b.opts) as any).receipt.event_id, b.lopts)).toMatchObject({ code: 0, data: { state: 'adopted' } })
  })

  it('promotion reuses an orphan creation event instead of minting a second global id', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    ;[0, 1, 2, 3].forEach(i => recordProbe(s, probeFor('L-0001', i, `c${i % 2}`, 'win')))
    adoptLesson('L-0001', 'project', reveal(s, 'L-0001'), s.lopts)
    const promo = decisionEvent({ operation_key: 'promo', payload: { decision_id: 'promote-L-0001', topic: 'promote?', options: ['promote', 'keep'], recommendation: null, initial_choice: null, final_choice: 'promote', final_position: 0, blind: false } })
    const d = (appendEvent(promo, s.opts) as any).receipt.event_id
    promoteLesson('L-0001', d, s.lopts)
    const gdir = lessonsDir(s.root, 'global', s.project.id)
    rmSync(join(gdir, 'entries', 'L-0001.md'))
    expect(promoteLesson('L-0001', d, { ...s.lopts, runId: 'retry' })).toMatchObject({ code: 0, data: { id: 'L-0001' } })
    const creations = readLog(join(s.root, 'global', 'events.jsonl')).events.filter(e => e.kind === 'lesson_state')
    expect(creations).toHaveLength(1)
    writeFileSync(join(s.root, 'global', 'events.jsonl'), '')
    expect(promoteLesson('L-0001', d, { ...s.lopts, runId: 'retry2' })).toMatchObject({ code: 0, message: 'L-0001 promoted as global L-0001' })
    expect(readLog(join(s.root, 'global', 'events.jsonl')).events.filter(e => e.kind === 'lesson_state')).toHaveLength(1)
    expect(promoteLesson('L-0001', d, s.lopts).message).toMatch(/already promoted/)
  })

  it('re-lints a duplicate candidate when the active lesson with its line retires, and resumes a crashed add', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    expect(addLesson(lessonInput(s.evidence, { cue: 'dup' }), s.lopts).data!.state).toBe('candidate')
    retireLesson('L-0001', 'project', 'superseded', s.lopts)
    expect(effectiveState(s.events(), 'project', 'L-0002', null)).toBe('trial')
    const t = setup('crash')
    addLesson(lessonInput(t.evidence, { line: 'Crash rule.' }), t.lopts)
    const log = join(t.root, 'projects', t.project.id, 'events.jsonl')
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    writeFileSync(log, `${lines.slice(0, -1).join('\n')}\n`)
    expect(addLesson(lessonInput(t.evidence, { line: 'Crash rule.' }), t.lopts)).toMatchObject({ code: 0, data: { id: 'L-0001', state: 'trial' } })
    expect(readLessons(lessonsDir(t.root, 'project', t.project.id))).toHaveLength(1)
  })

  it('never reissues the id of an unparseable entry', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    const dir = lessonsDir(s.root, 'project', s.project.id)
    writeFileSync(join(dir, 'entries', 'L-0001.md'), '---\nline: Use X\n---\n')
    expect(addLesson(lessonInput(s.evidence, { line: 'Another.' }), s.lopts).data!.id).toBe('L-0002')
  })

  it('keeps a conflicting global partner next to its project lesson within the limit', () => {
    const base = tmp()
    const a = setup('a', base)
    addLesson(lessonInput(a.evidence), a.lopts)
    ;[0, 1, 2, 3].forEach(i => recordProbe(a, probeFor('L-0001', i, `c${i % 2}`, 'win')))
    adoptLesson('L-0001', 'project', reveal(a, 'L-0001'), a.lopts)
    const promo = decisionEvent({ operation_key: 'promo', payload: { decision_id: 'promote-L-0001', topic: 'promote?', options: ['promote', 'keep'], recommendation: null, initial_choice: null, final_choice: 'promote', final_position: 0, blind: false } })
    promoteLesson('L-0001', (appendEvent(promo, a.opts) as any).receipt.event_id, a.lopts)
    const b = setup('b', base)
    addLesson(lessonInput(b.evidence, { line: 'Rule B1.', cue: 'other 1' }), b.lopts)
    addLesson(lessonInput(b.evidence, { line: 'Rule B2.' }), b.lopts)
    const rows = queryLessons(b.root, b.project.id, b.events(), q({ limit: 3 })).rows
    expect(rows.map(r => [r.lesson.id, r.lesson.scope, r.conflict])).toEqual([['L-0001', 'project', false], ['L-0002', 'project', true], ['L-0001', 'global', true]])
    const two = queryLessons(b.root, b.project.id, b.events(), q({ limit: 2 })).rows
    expect(two.map(r => r.lesson.id)).toEqual(['L-0001'])
  })

  it('P12: every printed line is ≤200 chars for limits 1, 5, 20 and libraries of 0, 1 and 10,000', () => {
    for (const size of [0, 1, 10_000]) {
      const s = setup(`size${size}`)
      const dir = lessonsDir(s.root, 'project', s.project.id)
      if (size) addLesson(lessonInput(s.evidence, { line: `r ${'x'.repeat(150)}` }), s.lopts)
      const tpl = readLessons(dir)[0]
      for (let i = 2; i <= size; i++) writeFileSync(join(dir, 'entries', `L-${String(i).padStart(5, '0')}.md`), serializeLesson({ ...tpl, id: `L-${String(i).padStart(5, '0')}`, line: `rule ${i} ${'é'.repeat(158)}` }))
      for (const limit of [1, 5, 20]) {
        const { rows } = queryLessons(s.root, s.project.id, s.events(), q({ limit, kind: 'backend', all: true }))
        expect(rows.length).toBe(Math.min(limit, size))
        for (const r of rows) expect([...queryLine(r)].length).toBeLessThanOrEqual(200)
      }
    }
  }, 120_000)

  // Output bounds are tested at 10,000 lessons (P12); timing is checked at 1,000, a generous real library, so slow CI disks don't flake.
  it('add and query stay under the lock timeout with 1,000 lessons and 2,000 state events', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    const dir = lessonsDir(s.root, 'project', s.project.id)
    const tpl = readLessons(dir)[0]
    const log = join(s.root, 'projects', s.project.id, 'events.jsonl')
    const base = s.events().at(-1)!
    const lines: string[] = []
    for (let i = 2; i <= 1_000; i++) {
      const id = `L-${String(i).padStart(5, '0')}`
      writeFileSync(join(dir, 'entries', `${id}.md`), serializeLesson({ ...tpl, id, line: `rule ${i}` }))
      for (const [n, from, to] of [[0, null, 'candidate'], [1, 'candidate', 'trial']] as const) {
        lines.push(JSON.stringify({ ...base, event_id: `x${i}-${n}`, operation_key: `x${i}-${n}`, seq: 1000 + i * 2 + n, payload: { ...base.payload, lesson_id: id, from, to } }))
      }
    }
    appendFileSync(log, `${lines.join('\n')}\n`)
    let t0 = Date.now()
    expect(addLesson(lessonInput(s.evidence, { line: 'Brand new rule.' }), s.lopts).code).toBe(0)
    expect(Date.now() - t0).toBeLessThan(2000)
    t0 = Date.now()
    queryLessons(s.root, s.project.id, s.events(), q())
    expect(Date.now() - t0).toBeLessThan(2000)
  }, 120_000)

  it('summary keys lessons by project, so equal ids in two projects stay separate', () => {
    const base = tmp()
    const a = setup('a', base)
    const b = setup('b', base)
    addLesson(lessonInput(a.evidence), a.lopts)
    addLesson(lessonInput(b.evidence), b.lopts)
    ;[0, 1].forEach(i => recordProbe(a, probeFor('L-0001', i, `a${i}`, 'win')))
    ;[0, 1].forEach(i => recordProbe(b, probeFor('L-0001', i, `b${i}`, 'win')))
    const merged = [...a.events(), ...b.events()].map((e, i) => ({ ...e, seq: i + 1 }))
    const s = summarize(merged).lessons
    expect(s.counts.project.trial).toBe(2)
    expect(s.pending).toHaveLength(0)
    expect(s.trials.map(t => t.W)).toEqual([2, 2])
  })
})

describe('round-2 fixes', () => {
  const q = (over: Record<string, unknown> = {}) => ({ files: [] as string[], kind: 'backend' as any, text: '', scope: 'both' as const, limit: 5, all: false, ...over })

  it('a hand-edited entry without events is never more than a candidate', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    const dir = lessonsDir(s.root, 'project', s.project.id)
    const l = readLessons(dir)[0]
    writeFileSync(join(dir, 'entries', 'L-0009.md'), serializeLesson({ ...l, id: 'L-0009', line: 'Rule Y', state: 'adopted' }))
    expect(queryLessons(s.root, s.project.id, s.events(), q()).rows.map(r => r.lesson.id)).toEqual(['L-0001'])
    expect(effectiveState(s.events(), 'project', 'L-0009', 'adopted')).toBe('candidate')
  })

  it('probes naming a nonexistent global lesson never write a retirement', () => {
    const s = setup()
    recordProbe(s, probeFor('L-0001', 0, 'c1', 'loss', 'global'))
    recordProbe(s, probeFor('L-0001', 1, 'c1', 'loss', 'global'))
    expect(s.events().filter(e => e.kind === 'lesson_state')).toHaveLength(0)
  })

  it('resumes a lesson whose trial event landed before its entry was rewritten', () => {
    const s = setup()
    addLesson(lessonInput(s.evidence), s.lopts)
    const dir = lessonsDir(s.root, 'project', s.project.id)
    writeFileSync(join(dir, 'entries', 'L-0001.md'), serializeLesson({ ...readLessons(dir)[0], state: 'candidate' }))
    expect(addLesson(lessonInput(s.evidence), s.lopts)).toMatchObject({ code: 0, data: { id: 'L-0001', state: 'trial' } })
    expect(readLessons(dir)).toHaveLength(1)
  })
})

describe('round-3 fixes', () => {
  it('a hand-made entry with the same line is not mistaken for a crashed add', () => {
    const s = setup()
    const dir = lessonsDir(s.root, 'project', s.project.id)
    mkdirSync(join(dir, 'entries'), { recursive: true })
    const hand = { id: 'L-0001', scope: 'project', state: 'adopted', slot: 'brief', line: 'Rule A.', cue: 'hand cue', match: { globs: [], kind: 'any', keywords: [] }, evidence: ['none'], contradicts: [], created_from: 'user', promoted_from: null, revision: 1, body: '' } as any
    writeFileSync(join(dir, 'entries', 'L-0001.md'), serializeLesson(hand))
    expect(addLesson(lessonInput(s.evidence, { line: 'Rule A.', cue: 'user cue' }), s.lopts)).toMatchObject({ code: 0, data: { id: 'L-0002', state: 'candidate' } })
    expect(effectiveState(s.events(), 'project', 'L-0001', 'adopted')).toBe('candidate')
  })
})

describe('round-3 fixes (2)', () => {
  const q = (over: Record<string, unknown> = {}) => ({ files: [] as string[], kind: 'backend' as any, text: '', scope: 'both' as const, limit: 5, all: false, ...over })

  it('rejects pathological globs at add time', () => {
    const s = setup()
    expect(addLesson(lessonInput(s.evidence, { match: { globs: ['{*,*}'.repeat(6) + 'b'], kind: 'any', keywords: [] } }), s.lopts).code).toBe(2)
    expect(addLesson(lessonInput(s.evidence, { match: { globs: ['src/**/*.{ts,tsx}'], kind: 'any', keywords: [] } }), s.lopts).code).toBe(0)
  })

  it('a project entry marked retired without events stays retired', () => {
    const s = setup()
    expect(effectiveState(s.events(), 'project', 'L-0042', 'retired')).toBe('retired')
  })

  it('moves a whole conflict group to the next page rather than splitting it', () => {
    const base = tmp()
    const a = setup('a', base)
    addLesson(lessonInput(a.evidence, { cue: 'same cue' }), a.lopts)
    ;[0, 1, 2, 3].forEach(i => recordProbe(a, probeFor('L-0001', i, `c${i % 2}`, 'win')))
    adoptLesson('L-0001', 'project', reveal(a, 'L-0001'), a.lopts)
    const promo = decisionEvent({ operation_key: 'promo', payload: { decision_id: 'promote-L-0001', topic: 'promote?', options: ['promote', 'keep'], recommendation: null, initial_choice: null, final_choice: 'promote', final_position: 0, blind: false } })
    promoteLesson('L-0001', (appendEvent(promo, a.opts) as any).receipt.event_id, a.lopts)
    const b = setup('b', base)
    addLesson(lessonInput(b.evidence, { line: 'Unrelated.', cue: 'other' }), b.lopts)
    addLesson(lessonInput(b.evidence, { line: 'P line 1.', cue: 'same cue' }), b.lopts)
    addLesson(lessonInput(b.evidence, { line: 'P line 2.', cue: 'same cue' }), b.lopts)
    const all = queryLessons(b.root, b.project.id, b.events(), q({ limit: 20 })).rows.map(r => `${r.lesson.scope}/${r.lesson.id}`)
    expect(all).toEqual(['project/L-0001', 'project/L-0002', 'global/L-0001', 'project/L-0003'])
    expect(queryLessons(b.root, b.project.id, b.events(), q({ limit: 2 })).rows.map(r => `${r.lesson.scope}/${r.lesson.id}`)).toEqual(['project/L-0001'])
    expect(queryLessons(b.root, b.project.id, b.events(), q({ limit: 3 })).rows).toHaveLength(3)
  })
})
