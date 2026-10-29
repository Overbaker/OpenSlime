import { existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { projectLog } from '../paths'
import { resolveProject } from '../project'
import { appendEvent, readLog, withLock } from '../store'
import { decisionEvent, mulberry32, probeEvent, shuffleKeys, stageEvent, tmp } from './fixtures'

function setup() {
  const base = tmp()
  const projectRoot = join(base, 'proj')
  mkdirSync(join(projectRoot, 'openspec'), { recursive: true })
  const root = join(base, 'ledger')
  const installDir = join(base, 'claude')
  const opts = { root, installDir, projectRoot, version: '9.9.9', env: {} }
  const log = projectLog(root, resolveProject(projectRoot).id)
  return { opts, log, root }
}

describe('appendEvent', () => {
  it('creates the layout lazily with private modes and writes nothing in the project', () => {
    const { opts, log, root } = setup()
    expect(existsSync(root)).toBe(false)
    const r = appendEvent(stageEvent(), opts)
    expect(r).toEqual({ code: 0, receipt: { status: 'appended', event_id: expect.stringMatching(/^[0-9a-f]{16}$/) } })
    expect(statSync(log).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'projects')).mode & 0o777).toBe(0o700)
    const meta = JSON.parse(readFileSync(join(log, '..', 'meta.json'), 'utf8'))
    expect(Object.keys(meta).sort()).toEqual(['created_at', 'name'])
    expect(meta.name).toBe('proj')
  })

  it('assigns identity, order and harness', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    appendEvent(decisionEvent(), opts)
    const { events } = readLog(log)
    expect(events.map(e => e.seq)).toEqual([1, 2])
    expect(events[0].producer).toBe('9.9.9')
    expect(events[0].harness.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(events[0].payload.confidence.band).toBe('Medium')
  })

  it('P1: an identical event appended again, with keys in any order, is a no-op', () => {
    const { opts, log } = setup()
    const first = appendEvent(stageEvent(), opts)
    const bytes = readFileSync(log)
    const rand = mulberry32(7)
    for (let i = 0; i < 20; i++) {
      const again = appendEvent(shuffleKeys(stageEvent(), rand), opts)
      expect(again).toEqual({ code: 0, receipt: { status: 'duplicate', event_id: (first as any).receipt.event_id } })
    }
    expect(readFileSync(log).equals(bytes)).toBe(true)
  })

  it('P2: the same identity with a different payload is a conflict and changes nothing', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    const bytes = readFileSync(log)
    const mutations: Array<(e: any) => void> = [
      e => { e.payload.status = 'failed' },
      e => { e.payload.confidence.percent = 80 },
      e => { e.payload.verify = null },
      e => { e.payload.invocations[0].accepted = 4 },
      e => { e.change_id = 'c2' },
      e => { e.stage = 'plan' },
      e => { e.payload.invocations[0].skills = ['frontend-design'] },
      e => { e.payload.invocations.push({ ...e.payload.invocations[0], backend: 'antigravity' }) },
    ]
    for (const mutate of mutations) {
      const e = stageEvent()
      mutate(e)
      expect(appendEvent(e, opts).code).toBe(5)
    }
    expect(readFileSync(log).equals(bytes)).toBe(true)
  })

  it('P4: a torn tail at any offset leaves complete lines readable and the next append intact', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    appendEvent(decisionEvent(), opts)
    const full = readFileSync(log)
    const firstEnd = full.indexOf(0x0A) + 1
    for (let offset = 0; offset < full.length; offset++) {
      writeFileSync(log, full)
      truncateSync(log, offset)
      const before = readLog(log)
      const whole = offset === full.length - 1
      expect(before.events.length).toBe(whole ? 2 : offset >= firstEnd - 1 ? 1 : 0)
      expect(before.invalid).toBe(offset === 0 || offset === firstEnd || offset === firstEnd - 1 || whole ? 0 : 1)
      const r = appendEvent(decisionEvent({ operation_key: `after-${offset}` }), opts)
      expect(r.code).toBe(0)
      const after = readLog(log)
      expect(after.events.at(-1)!.operation_key).toBe(`after-${offset}`)
      expect(after.invalid).toBe(before.invalid)
    }
  }, 60_000)

  it('resolves an outcome to the latest matching stage event', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent({ stage: 'impl', phase_id: '2', operation_key: 'a' }), opts)
    appendEvent(stageEvent({ stage: 'impl', phase_id: '2', operation_key: 'b', run_id: 'run-2' }), opts)
    appendEvent(stageEvent({ stage: 'impl', phase_id: '3', operation_key: 'c' }), opts)
    const outcome = { ...stageEvent(), kind: 'outcome', operation_key: 'o', payload: { target: { change_id: 'c1', stage: 'impl', phase_id: '2' }, assessment: 'review', result: 'passed', critical_count: 0 } }
    expect(appendEvent(outcome, opts).code).toBe(0)
    const { events } = readLog(log)
    expect(events.at(-1)!.payload.target_event_id).toBe(events[1].event_id)
    expect(appendEvent(outcome, opts)).toMatchObject({ code: 0, receipt: { status: 'duplicate' } })
    const missing = { ...outcome, operation_key: 'o2', payload: { ...outcome.payload, target: { change_id: 'c9', stage: 'plan', phase_id: null } } }
    expect(appendEvent(missing, opts).code).toBe(2)
  })

  it('is a no-op when off', () => {
    const { opts, root } = setup()
    expect(appendEvent(stageEvent(), { ...opts, env: { OSM_LEDGER: '0' } })).toEqual({ code: 0, receipt: { status: 'disabled', event_id: null } })
    expect(existsSync(root)).toBe(false)
    mkdirSync(root)
    writeFileSync(join(root, 'disabled'), '')
    expect(appendEvent(stageEvent(), opts)).toMatchObject({ receipt: { status: 'disabled' } })
    expect(existsSync(join(root, 'projects'))).toBe(false)
  })

  it('rejects invalid input with exit 2 and leaves the log unchanged', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    const bytes = readFileSync(log)
    expect(appendEvent({ ...stageEvent(), harness: {} }, opts).code).toBe(2)
    expect(appendEvent({ ...stageEvent(), operation_key: 'x', extra: true }, opts).code).toBe(2)
    expect(readFileSync(log).equals(bytes)).toBe(true)
  })

  it('times out with exit 3 when the lock is held, and never steals it', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    writeFileSync(`${log}.lock`, JSON.stringify({ pid: 1, host: 'h', token: 'other' }))
    const started = Date.now()
    expect(appendEvent(decisionEvent(), opts).code).toBe(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    expect(existsSync(`${log}.lock`)).toBe(true)
  })

  it('P2 for every kind: decision, probe and outcome payload changes conflict', () => {
    const { opts } = setup()
    appendEvent(stageEvent(), opts)
    const decision = decisionEvent()
    appendEvent(decision, opts)
    decision.payload.final_choice = 'repo'
    decision.payload.final_position = 1
    expect(appendEvent(decision, opts).code).toBe(5)
    const probe = probeEvent()
    appendEvent(probe, opts)
    probe.payload.candidates[1].critical_confirmed = 2
    expect(appendEvent(probe, opts).code).toBe(5)
    const outcome = { ...stageEvent(), kind: 'outcome', operation_key: 'o', payload: { target: { change_id: 'c1', stage: 'review', phase_id: null }, assessment: 'review', result: 'passed', critical_count: 0 } }
    appendEvent(outcome, opts)
    expect(appendEvent({ ...outcome, payload: { ...outcome.payload, critical_count: 1 } }, opts).code).toBe(5)
  })

  it('a failed first write leaves no project directory or meta.json', () => {
    const { opts, log } = setup()
    const outcome = { ...stageEvent(), kind: 'outcome', operation_key: 'o', payload: { target: { change_id: 'c9', stage: 'plan', phase_id: null }, assessment: 'review', result: 'passed', critical_count: 0 } }
    expect(appendEvent(outcome, opts).code).toBe(2)
    expect(existsSync(join(log, '..'))).toBe(false)
  })

  it('the lock timeout error names the lock and how to remove it', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    writeFileSync(`${log}.lock`, JSON.stringify({ pid: 1, host: 'h', token: 'other' }))
    const r = appendEvent(decisionEvent(), opts) as { code: number, error: string }
    expect(r.code).toBe(3)
    expect(r.error).toContain(`rm '${log}.lock'`)
  })

  it('a torn copy of a retried event does not hide the valid copy', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    appendEvent(decisionEvent(), opts)
    truncateSync(log, readFileSync(log).length - 40)
    expect(appendEvent(decisionEvent(), opts)).toMatchObject({ receipt: { status: 'appended' } })
    expect(appendEvent(decisionEvent(), opts)).toMatchObject({ receipt: { status: 'duplicate' } })
    const changed = decisionEvent()
    changed.payload.final_choice = 'repo'
    changed.payload.final_position = 1
    expect(appendEvent(changed, opts).code).toBe(5)
    const { events, invalid } = readLog(log)
    expect(events.filter(e => e.kind === 'human_decision')).toHaveLength(1)
    expect(invalid).toBe(1)
  })

  it('recreates a project dir removed between ensureDir and the lock', () => {
    const { log } = setup()
    expect(withLock(log, () => 'ran')).toBe('ran')
    rmSync(join(log, '..'), { recursive: true })
    expect(withLock(log, () => 'again')).toBe('again')
  })

  it('a git child killed by a signal is a storage error (4), not a bad event (2)', () => {
    const { opts } = setup()
    const bin = tmp('osm-git-')
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      expect(() => resolveProject(opts.projectRoot)).toThrow(/interrupted by SIGKILL/)
      expect(appendEvent(stageEvent(), opts).code).toBe(4)
    }
    finally {
      process.env.PATH = path
    }
  })

  it('writes a missing meta.json on a duplicate retry', () => {
    const { opts, log } = setup()
    appendEvent(stageEvent(), opts)
    rmSync(join(log, '..', 'meta.json'))
    expect(appendEvent(stageEvent(), opts)).toMatchObject({ receipt: { status: 'duplicate' } })
    expect(existsSync(join(log, '..', 'meta.json'))).toBe(true)
  })
})
