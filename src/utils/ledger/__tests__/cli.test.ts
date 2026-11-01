import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { decisionEvent, stageEvent, tmp } from './fixtures'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
// Spawned from a temp cwd, so `--import tsx` cannot resolve the package by name.
const tsx = pathToFileURL(join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const cliEntry = join(repo, 'src', 'cli.ts')

/** Async, so a test that runs many CLI calls never blocks the vitest worker (its RPC times out on slow CI). */
async function osm(args: string[], input: string | null, env: Record<string, string> = {}, projectName = 'proj'): Promise<{ code: number | null, stdout: string, stderr: string, home: string }> {
  const home = env.HOME ?? tmp('osm-home-')
  const project = join(home, projectName)
  mkdirSync(join(project, 'openspec'), { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cliEntry, 'ledger', ...args], {
      cwd: project,
      env: { ...process.env, OSM_LEDGER: '', ...env, HOME: home },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr, home }))
    child.stdin.end(input ?? '')
  })
}

describe('osm ledger CLI exit codes', () => {
  it('appends, then reports a duplicate', async () => {
    const first = (await osm(['append'], JSON.stringify(decisionEvent())))
    expect(first.code).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ status: 'appended' })
    const again = (await osm(['append'], JSON.stringify(decisionEvent()), { HOME: first.home }))
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'duplicate' })
    const status = (await osm(['status', '--json'], null, { HOME: first.home }))
    expect(JSON.parse(status.stdout)).toMatchObject({ enabled: true, events: 1, invalid: 0, lock: null })
  }, 30_000)

  it('exits 2 on empty stdin, invalid JSON, schema errors and usage errors', async () => {
    expect((await osm(['append'], '')).code).toBe(2)
    expect((await osm(['append'], 'nope')).code).toBe(2)
    expect((await osm(['append'], JSON.stringify({ ...decisionEvent(), extra: 1 }))).code).toBe(2)
    expect((await osm(['append', '--project-root'], '{}')).code).toBe(2)
    expect((await osm(['status', '--project-root', '/nonexistent/x'], null)).code).toBe(2)
    expect((await osm(['bogus'], null)).code).toBe(2)
  }, 60_000)

  it('returns a disabled receipt and exit 0 when off, whatever stdin holds', async () => {
    const r = (await osm(['append'], 'garbage', { OSM_LEDGER: '0' }))
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ status: 'disabled', event_id: null })
  }, 30_000)

})

describe('osm ledger summary and harness', () => {
  async function seeded() {
    const first = (await osm(['append'], JSON.stringify(decisionEvent())))
    for (let i = 0; i < 3; i++) await osm(['append'], JSON.stringify(decisionEvent({ operation_key: `other-${i}`, payload: { ...decisionEvent().payload, final_choice: 'repo', final_position: 1 } })), { HOME: first.home })
    return first.home
  }

  it('prints byte-identical summaries under different TZ and LANG', async () => {
    const home = await seeded()
    const a = (await osm(['summary'], null, { HOME: home, TZ: 'UTC', LANG: 'C' }))
    const b = (await osm(['summary'], null, { HOME: home, TZ: 'Asia/Kolkata', LANG: 'zh_CN.UTF-8' }))
    expect(a.code).toBe(0)
    expect(a.stdout).toBe(b.stdout)
    expect(a.stdout).toContain('Human decisions n=4: adopted 1 · reversed 0 · overrode 3')
    const json = JSON.parse((await osm(['summary', '--json'], null, { HOME: home })).stdout)
    expect(json).toMatchObject({ totals: { events: 4 }, omitted_groups: 0, influence: { decisions: 4 } })
    expect(json.rules).toBeUndefined()
  }, 60_000)

  it('compares harness cohorts, prints rules and params, and rejects bad bounds', async () => {
    const home = await seeded()
    const by = (await osm(['summary', '--by-harness', '--json'], null, { HOME: home }))
    expect(JSON.parse(by.stdout).cohorts).toHaveLength(1)
    const rules = JSON.parse((await osm(['harness', '--json'], null, { HOME: home })).stdout)
    expect(rules.all.map((r: any) => r.id)).toEqual(['H-0001', 'H-0002', 'H-0003', 'H-0004', 'H-0005'])
    expect(rules.install).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.parse((await osm(['harness', '--params', '--json'], null, { HOME: home })).stdout).probe.perChange).toBe(2)
    expect((await osm(['summary', '--limit', '0'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['summary', '--project', 'nope'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['summary', '--all-projects'], null, { HOME: home })).stdout).toContain('all projects (1)')
  }, 60_000)

  it('groups by dimension and by decision dimension, and rejects bad --by, --window and --runs', async () => {
    const home = await seeded()
    const skill = await osm(['summary', '--by', 'skill'], null, { HOME: home })
    expect(skill.code).toBe(0)
    expect(skill.stdout).toContain('by skill (recorded) · associations, not causes · Holm m=0')
    const dec = JSON.parse((await osm(['summary', '--by', 'decision', '--json'], null, { HOME: home })).stdout)
    expect(dec.rows.find((r: any) => r.dimension === 'unknown')).toMatchObject({ n: 4, adopted: 1, overrode: 3 })
    const win = JSON.parse((await osm(['summary', '--by', 'window', '--window', '7', '--runs', '2', '--json'], null, { HOME: home })).stdout)
    expect(win).toMatchObject({ by: 'window', source: 'recorded', totals: { items: 0 } })
    const aliasHome = tmp('osm-home-')
    const skills = Array.from({ length: 25 }, (_, i) => `k${String(i).padStart(2, '0')}`)
    const st = stageEvent()
    st.payload.invocations = [{ ...st.payload.invocations[0], skills, accepted: 1, rejected: 0 }]
    await osm(['append'], JSON.stringify(st), { HOME: aliasHome })
    const alias = JSON.parse((await osm(['summary', '--by', 'skill', '--json'], null, { HOME: aliasHome })).stdout)
    expect(alias.items[0].rows[0]).toMatchObject({ aliased_omitted: 4 })
    expect(alias.items[0].rows[0].aliased_with).toHaveLength(20)
    expect((await osm(['summary', '--by', 'budget'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['summary', '--by', 'skill', '--window', '14'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['summary', '--by', 'skill', '--runs', '0'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['summary', '--by', 'skill', '--by-harness'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['summary', '--runs', '3'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['summary', '--by', 'decision', '--window', '7'], null, { HOME: home })).code).toBe(2)
  }, 90_000)
})

describe('summary over imperfect logs', () => {
  it('counts schema-invalid JSON lines as invalid instead of failing, and reads the global log', async () => {
    const home = (await osm(['append'], JSON.stringify(decisionEvent()))).home
    const status = JSON.parse((await osm(['status', '--json'], null, { HOME: home })).stdout)
    const log = join(status.root, 'projects', status.project_id, 'events.jsonl')
    appendFileSync(log, '{"event_id":"x","seq":9,"kind":"stage_completed"}\n')
    for (const args of [['summary'], ['summary', '--by-harness'], ['harness']]) {
      expect((await osm(args, null, { HOME: home })).code).toBe(0)
    }
    expect(JSON.parse((await osm(['summary', '--json'], null, { HOME: home })).stdout).invalid).toBe(1)
    expect(JSON.parse((await osm(['summary', '--by-harness', '--json'], null, { HOME: home })).stdout).invalid).toBe(1)
    mkdirSync(join(status.root, 'global'), { recursive: true })
    writeFileSync(join(status.root, 'global', 'events.jsonl'), 'garbage\n')
    expect(JSON.parse((await osm(['summary', '--json'], null, { HOME: home })).stdout).invalid).toBe(2)
    expect((await osm(['summary', '--project', status.project_id, '--all-projects'], null, { HOME: home })).code).toBe(2)
  }, 60_000)
})

describe('harness revisit edits nothing (P17 / "Revisit flagged, nothing edited")', () => {
  function manifest(dir: string): string {
    const out: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else out.push(`${p} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
      }
    }
    walk(dir)
    return out.join('\n')
  }

  it('flags H-0003 revisit with numbers and leaves every file under HOME unchanged', async () => {
    const home = tmp('osm-home-')
    mkdirSync(join(home, '.claude', 'commands', 'osm'), { recursive: true })
    writeFileSync(join(home, '.claude', 'commands', 'osm', 'impl.md'), 'impl v1')
    const skip = (i: number) => ({ ...decisionEvent(), stage: 'impl', phase_id: '1', kind: 'probe', operation_key: `skip-${i}`, payload: { lesson_id: 'L-0001', lesson_scope: 'project', mode: 'lesson', skip_reason: 'budget', candidates: [], interdiff_lines: null, ab_map_recorded_after_reviews: null, landed: null, forced: false } })
    const win = (i: number) => ({ ...skip(i), operation_key: `probe-${i}`, payload: { ...skip(i).payload, skip_reason: null, candidates: [
      { label: 'A', has_lesson: true, fingerprint: 'f', verify: 'passed', critical_confirmed: 0, warning_confirmed: 0, diff_lines: 3 },
      { label: 'B', has_lesson: false, fingerprint: 'f', verify: 'passed', critical_confirmed: 1, warning_confirmed: 0, diff_lines: 3 },
    ], interdiff_lines: 4, ab_map_recorded_after_reviews: true, landed: 'A' } })
    for (let i = 0; i < 12; i++) expect((await osm(['append'], JSON.stringify(skip(i)), { HOME: home })).code).toBe(0)
    for (let i = 0; i < 8; i++) expect((await osm(['append'], JSON.stringify(win(i)), { HOME: home })).code).toBe(0)
    const before = manifest(home)
    const text = (await osm(['harness'], null, { HOME: home })).stdout
    expect(text).toMatch(/H-0003 Probe budget .*current: revisit \(budget skips 12 > credited 8 \(n=20\)\)/)
    await osm(['summary', '--by-harness'], null, { HOME: home })
    await osm(['summary'], null, { HOME: home })
    expect(manifest(home)).toBe(before)
  }, 120_000)
})

describe('merged project + global logs', () => {
  it('orders events from two logs with one project id by recorded_at, so cohort dates never invert', async () => {
    const home = (await osm(['append'], JSON.stringify(decisionEvent()), {})).home
    const status = JSON.parse((await osm(['status', '--json'], null, { HOME: home })).stdout)
    const log = join(status.root, 'projects', status.project_id, 'events.jsonl')
    const base = JSON.parse(readFileSync(log, 'utf8').trim())
    const line = (seq: number, at: string, install: string) => JSON.stringify({ ...base, event_id: `e${seq}${install}`, operation_key: `k${seq}${install}`, seq, recorded_at: at, harness: { ...base.harness, install } })
    writeFileSync(log, `${[line(1, '2026-01-01T00:00:00.000Z', 'OLD'), line(2, '2026-02-01T00:00:00.000Z', 'OLD'), line(3, '2026-09-01T00:00:00.000Z', 'NEW')].join('\n')}\n`)
    mkdirSync(join(status.root, 'global'), { recursive: true })
    writeFileSync(join(status.root, 'global', 'events.jsonl'), `${line(1, '2026-10-01T00:00:00.000Z', 'NEW')}\n`)
    const by = JSON.parse((await osm(['summary', '--by-harness', '--json'], null, { HOME: home })).stdout)
    expect(by.cohorts.map((c: any) => [c.install, c.first, c.last])).toEqual([['OLD', '2026-01-01', '2026-02-01'], ['NEW', '2026-09-01', '2026-10-01']])
  }, 60_000)
})

describe('merge keeps each log in seq order', () => {
  it('an unrelated global event does not reorder a project log whose clock stepped back', async () => {
    const home = (await osm(['append'], JSON.stringify(decisionEvent()))).home
    const status = JSON.parse((await osm(['status', '--json'], null, { HOME: home })).stdout)
    const log = join(status.root, 'projects', status.project_id, 'events.jsonl')
    const base = JSON.parse(readFileSync(log, 'utf8').trim())
    const stageEv = { ...base, event_id: 's1', operation_key: 's1', seq: 1, recorded_at: '2026-10-29T10:00:00.000Z', kind: 'stage_completed', stage: 'review', payload: { status: 'completed', confidence: { percent: 90, band: 'High' }, verify: null, invocations: [] } }
    const out = (id: string, seq: number, at: string, result: string) => ({ ...base, event_id: id, operation_key: id, seq, recorded_at: at, kind: 'outcome', stage: 'review', payload: { target: { change_id: base.change_id ?? 'c1', stage: 'review', phase_id: null }, assessment: 'verify', result, critical_count: null, target_event_id: 's1' } })
    writeFileSync(log, `${[stageEv, out('o1', 2, '2026-10-29T10:00:04.000Z', 'passed'), out('o2', 3, '2026-10-29T10:00:03.000Z', 'failed')].map(e => JSON.stringify(e)).join('\n')}\n`)
    const observed = async () => JSON.parse((await osm(['summary', '--json'], null, { HOME: home })).stdout).calibration.verify.find((r: any) => r.band === 'High').observed
    expect(await observed()).toBe(1)
    mkdirSync(join(status.root, 'global'), { recursive: true })
    writeFileSync(join(status.root, 'global', 'events.jsonl'), `${JSON.stringify({ ...base, project_id: 'p_ffffffffffffffff', event_id: 'g1', operation_key: 'g1', seq: 1, recorded_at: '2026-10-29T09:00:00.000Z' })}\n`)
    expect(await observed()).toBe(1)
  }, 60_000)
})

describe('lessons end to end', () => {
  it('add → 4 winning probes over 2 changes → reveal → adopt → query shows adopted first; summary shows lesson status', async () => {
    const seed = (await osm(['append'], JSON.stringify(decisionEvent())))
    const home = seed.home
    const evidence = JSON.parse(seed.stdout).event_id
    const lesson = { line: 'Validate every row ID before the first write.', cue: 'bulk import', match: { globs: ['src/import/**'], kind: 'backend', keywords: ['import'] }, evidence: [evidence], created_from: 'review F1' }
    const added = (await osm(['lessons', 'add', '--json'], JSON.stringify(lesson), { HOME: home }))
    expect(JSON.parse(added.stdout)).toMatchObject({ id: 'L-0001', state: 'trial' })
    await osm(['lessons', 'add'], JSON.stringify({ ...lesson, line: 'Another trial rule.', cue: 'other' }), { HOME: home })

    const probe = (n: number, change: string) => ({
      schema_version: 1, run_id: `r${n}`, change_id: change, stage: 'impl', phase_id: '1', kind: 'probe', operation_key: `p${n}`,
      payload: { lesson_id: 'L-0001', lesson_scope: 'project', mode: 'lesson', skip_reason: null, forced: false, interdiff_lines: 3, ab_map_recorded_after_reviews: true, landed: 'A',
        writer: { backend: 'codex', role: 'builder', model: null },
        candidates: [
          { label: 'A', has_lesson: true, fingerprint: 'f', verify: 'passed', critical_confirmed: 0, warning_confirmed: 0, diff_lines: 4 },
          { label: 'B', has_lesson: false, fingerprint: 'f', verify: 'passed', critical_confirmed: 1, warning_confirmed: 0, diff_lines: 4 },
        ] },
    })
    for (let i = 0; i < 4; i++) expect((await osm(['append'], JSON.stringify(probe(i, i < 2 ? 'c1' : 'c2')), { HOME: home })).code).toBe(0)
    const pending = (await osm(['summary'], null, { HOME: home })).stdout
    expect(pending).toContain('pending adoption: L-0001 (project) W4 L0 · wins from 2 changes')

    expect((await osm(['lessons', 'adopt', 'L-0001', '--decision', 'x'], null, { HOME: home })).code).toBe(2)
    const revealEvent = { ...decisionEvent(), operation_key: 'reveal', payload: { decision_id: 'reveal-L-0001', topic: 'Adopt L-0001?', options: ['adopt', 'keep-trial', 'retire'], recommendation: 'adopt', initial_choice: null, final_choice: 'adopt', final_position: 0, blind: false } }
    const decision = JSON.parse((await osm(['append'], JSON.stringify(revealEvent), { HOME: home })).stdout).event_id
    const adopted = (await osm(['lessons', 'adopt', 'L-0001', '--decision', decision, '--confirm', '--json'], null, { HOME: home }))
    expect(JSON.parse(adopted.stdout)).toMatchObject({ id: 'L-0001', state: 'adopted' })

    const q = (await osm(['lessons', 'query', '--files', 'src/import/rows.ts', '--kind', 'backend', '--text', 'bulk import'], null, { HOME: home })).stdout.trim().split('\n')
    expect(q[0]).toMatch(/^L-0001 adopted project "Validate every row ID/)
    expect(q[1]).toMatch(/^L-0002 trial project/)
    const st = stageEvent({ operation_key: 'uses-agy' })
    st.payload.invocations = [{ ...st.payload.invocations[0], backend: 'antigravity' }]
    expect((await osm(['append'], JSON.stringify(st), { HOME: home })).code).toBe(0)
    const card = (await osm(['lessons', 'show', 'L-0001'], null, { HOME: home })).stdout
    expect(card).toContain('tally: W4 L0 T0')
    expect(card).toContain('evidence from: backend codex ×4 · model (unknown) ×4 · role builder ×4')
    expect(card).toMatch(/untested on: backend antigravity, claude · role reviewer/)
    const summary = (await osm(['summary'], null, { HOME: home })).stdout
    expect(summary).toContain('Lessons project: trial 1 · adopted 1 · candidate 0 · retired 0')
    expect(summary).not.toContain('pending adoption')
    expect(JSON.parse((await osm(['status', '--json'], null, { HOME: home })).stdout).lessons).toBe(2)
    expect((await osm(['lessons', 'retire', 'L-0002'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['lessons', 'retire', 'L-0002', '--reason', 'not useful'], null, { HOME: home })).stdout).toContain('L-0002 retired')
    expect((await osm(['lessons', 'bogus'], null, { HOME: home })).code).toBe(2)
  }, 120_000)
})

describe('lesson state cannot be forged through append', () => {
  it('rejects a raw lesson_state event with exit 2', async () => {
    const ev = { ...decisionEvent(), stage: 'lesson', kind: 'lesson_state', operation_key: 'forge', payload: { lesson_id: 'L-0001', scope: 'project', from: 'trial', to: 'adopted', reason: 'x', tally: { W: 0, L: 0, T: 0, inert: 0, void: 0, changes_with_wins: 0, severe_losses: 0 } } }
    const r = (await osm(['append'], JSON.stringify(ev)))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('written only by `osm ledger lessons`')
  }, 30_000)
})

describe('osm ledger position', () => {
  it('prints the recommended index and rejects missing or out-of-range arguments', async () => {
    const { recommendedIndex } = await import('../store')
    const ok = await osm(['position', '--run-id', 'r-1', '--decision-id', 'q1', '--options', '3'], null)
    expect(ok.code).toBe(0)
    expect(Number(ok.stdout.trim())).toBe(recommendedIndex('r-1', 'q1', 3))
    expect((await osm(['position', '--run-id', 'r-1', '--options', '3'], null)).code).toBe(2)
    expect((await osm(['position', '--run-id', 'r-1', '--decision-id', 'q1', '--options', '9'], null)).code).toBe(2)
  }, 60_000)
})


describe('osm ledger render', () => {
  function manifest(dir: string): Record<string, string> {
    const outm: Record<string, string> = {}
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else outm[p] = createHash('sha256').update(readFileSync(p)).digest('hex')
      }
    }
    walk(dir)
    return outm
  }

  it('writes both themes under renders/, keeps the tree and log untouched, and hides canaries', async () => {
    const repo = 'zqcanaryrepo'
    const first = await osm(['append'], JSON.stringify(decisionEvent({ change_id: 'zqcanarychange', payload: { ...decisionEvent().payload, topic: 'zqcanarytopic', decision_id: 'zqcanarydecision' } })), {}, repo)
    expect(first.code).toBe(0)
    const home = first.home
    const ledgerRoot = join(home, '.claude', 'osm-ledger')
    const before = manifest(ledgerRoot)
    const projectBefore = manifest(join(home, repo))
    for (const args of [['summary'], ['summary', '--by', 'skill'], ['position', '--run-id', 'r', '--decision-id', 'd', '--options', '3']]) await osm(args, null, { HOME: home }, repo)
    expect(manifest(ledgerRoot)).toEqual(before)
    const r = await osm(['render', '--svg'], null, { HOME: home, TZ: 'UTC' }, repo)
    expect(r.code).toBe(0)
    const after = manifest(ledgerRoot)
    const added = Object.keys(after).filter(k => !(k in before))
    expect(added.map(k => k.slice(ledgerRoot.length)).sort()).toEqual([expect.stringMatching(/^\/renders\/p_[0-9a-f]{16}-dark\.svg$/), expect.stringMatching(/^\/renders\/p_[0-9a-f]{16}-light\.svg$/)])
    for (const k of Object.keys(before)) expect(after[k]).toBe(before[k])
    expect(manifest(join(home, repo))).toEqual(projectBefore)
    expect(r.stdout).toContain('<picture>')
    const light = readFileSync(added.find(k => k.endsWith('light.svg'))!, 'utf8')
    for (const canary of ['zqcanary', home]) expect(light).not.toContain(canary)
    expect(light).toMatch(/n = 1 events · 1 runs · 1 changes · data: \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/)
    const shanghai = await osm(['render', '--svg', '--out', '-', '--theme', 'light'], null, { HOME: home, TZ: 'Asia/Shanghai', LANG: 'zh_CN.UTF-8' }, repo)
    expect(shanghai.stdout).toBe(light)
    expect((await osm(['render', '--svg', '--out', '-', '--theme', 'light', '--show-names'], null, { HOME: home }, repo)).stdout).toContain(repo)
    const pid = added[0].match(/p_[0-9a-f]{16}/)![0]
    const byId = await osm(['render', '--svg', '--out', '-', '--theme', 'dark', '--project', pid], null, { HOME: home }, repo)
    expect(byId.code).toBe(0)
    expect(byId.stdout).not.toContain(repo)
    expect((await osm(['render', '--svg', '--out', '-', '--theme', 'dark', '--project', pid, '--show-names'], null, { HOME: home }, repo)).stdout).toContain(repo)
  }, 90_000)

  it('refuses to overwrite a foreign file without --force and validates options', async () => {
    const home = (await osm(['append'], JSON.stringify(decisionEvent()))).home
    const foreign = join(home, 'mine.svg')
    writeFileSync(foreign, '<svg/>')
    expect((await osm(['render', '--svg', '--out', foreign, '--theme', 'light'], null, { HOME: home })).code).toBe(2)
    expect(readFileSync(foreign, 'utf8')).toBe('<svg/>')
    expect((await osm(['render', '--svg', '--out', foreign, '--theme', 'light', '--force'], null, { HOME: home })).code).toBe(0)
    expect(readFileSync(foreign, 'utf8')).toContain('<!-- osm-ledger render -->')
    expect((await osm(['render', '--svg', '--out', foreign, '--theme', 'light'], null, { HOME: home })).code).toBe(0)
    expect((await osm(['render'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['render', '--svg', '--out', 'x.png'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['render', '--svg', '--theme', 'sepia'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['render', '--svg', '--by', 'budget'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['render', '--svg', '--out', '-'], null, { HOME: home })).code).toBe(2)
    expect((await osm(['render', '--svg', '--out', '--theme', 'light'], null, { HOME: home })).code).toBe(2)
    const victim = join(home, 'victim.txt')
    const link = join(home, 'link.svg')
    symlinkSync(victim, link)
    expect((await osm(['render', '--svg', '--out', link, '--theme', 'light', '--force'], null, { HOME: home })).code).toBe(2)
    expect(existsSync(victim)).toBe(false)
    const dirTarget = join(home, 'adir.svg')
    mkdirSync(dirTarget)
    expect((await osm(['render', '--svg', '--out', dirTarget, '--theme', 'dark', '--force'], null, { HOME: home })).code).toBe(2)
    const both = join(home, 'pair.svg')
    writeFileSync(join(home, 'pair-dark.svg'), 'mine')
    expect((await osm(['render', '--svg', '--out', both], null, { HOME: home })).code).toBe(2)
    expect(existsSync(join(home, 'pair-light.svg'))).toBe(false)
    writeFileSync(foreign, `<svg>\n<desc><!-- osm-ledger render --></desc>`)
    expect((await osm(['render', '--svg', '--out', foreign, '--theme', 'light'], null, { HOME: home })).code).toBe(2)
  }, 90_000)
})
