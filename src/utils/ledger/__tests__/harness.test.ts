import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { computeHarness, harnessDigest, harnessFiles, paramsHash } from '../harness'
import { PARAMS } from '../params'
import { appendEvent, readLog } from '../store'
import { projectLog } from '../paths'
import { resolveProject } from '../project'
import { stageEvent, tmp } from './fixtures'

function install(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
}

const FILES = {
  'commands/osm/review.md': 'review v1',
  '.ccg/prompts/claude/osm-report.md': 'report v1',
  '.ccg/prompts/codex/reviewer.md': 'reviewer v1',
}

describe('P16: harness fingerprint', () => {
  it('lists the command template, report spec and the invoked role files', () => {
    expect(harnessFiles(stageEvent())).toEqual(['.ccg/prompts/claude/osm-report.md', '.ccg/prompts/codex/reviewer.md', 'commands/osm/review.md'])
    expect(harnessFiles({ stage: 'lesson', kind: 'lesson_state', payload: {} })).toEqual([])
  })

  it('changes the digest if and only if a fingerprinted file changes', () => {
    const dir = tmp()
    install(dir, FILES)
    const base = computeHarness(stageEvent(), dir, '1.0.0')
    expect(computeHarness(stageEvent(), dir, '1.0.0')).toEqual(base)
    expect(computeHarness(stageEvent(), dir, '2.0.0').digest).toBe(base.digest)
    install(dir, { 'commands/osm/plan.md': 'unrelated' })
    expect(computeHarness(stageEvent(), dir, '1.0.0').digest).toBe(base.digest)
    for (const rel of Object.keys(FILES)) {
      install(dir, { ...FILES, [rel]: `${FILES[rel as keyof typeof FILES]}!` })
      const changed = computeHarness(stageEvent(), dir, '1.0.0')
      expect(changed.digest).not.toBe(base.digest)
      expect(Object.keys(changed.files).filter(k => changed.files[k] !== base.files[k])).toEqual([rel])
      install(dir, FILES)
    }
  })

  it('records null for a missing file', () => {
    const h = computeHarness(stageEvent(), tmp(), '1.0.0')
    expect(Object.values(h.files).every(v => v === null)).toBe(true)
  })

  it('PARAMS is frozen, so the params hash cannot drift at runtime', () => {
    expect(Object.isFrozen(PARAMS)).toBe(true)
    expect(Object.isFrozen(PARAMS.lessons.adopt)).toBe(true)
  })

  it('excludes harness from duplicate comparison', () => {
    const base = tmp()
    const projectRoot = join(base, 'proj')
    mkdirSync(join(projectRoot, 'openspec'), { recursive: true })
    const installDir = join(base, 'claude')
    install(installDir, FILES)
    const opts = { root: join(base, 'ledger'), installDir, projectRoot, version: 't', env: {} }
    expect(appendEvent(stageEvent(), opts)).toMatchObject({ receipt: { status: 'appended' } })
    install(installDir, { 'commands/osm/review.md': 'review v2' })
    expect(appendEvent(stageEvent(), opts)).toMatchObject({ receipt: { status: 'duplicate' } })
    expect(appendEvent(stageEvent({ operation_key: 'second' }), opts)).toMatchObject({ receipt: { status: 'appended' } })
    const { events } = readLog(projectLog(opts.root, resolveProject(projectRoot).id))
    expect(events[0].harness.digest).not.toBe(events[1].harness.digest)
  })

  it('changes the digest when params change', () => {
    const files = { 'commands/osm/review.md': 'abc' }
    expect(harnessDigest(files, paramsHash())).not.toBe(harnessDigest(files, 'ffffffffffff'))
  })

  it('install digest ignores stage and invocations but tracks every installed template', () => {
    const dir = tmp()
    install(dir, { ...FILES, 'commands/osm/plan.md': 'plan v1', '.ccg/prompts/antigravity/reviewer.md': 'ag v1' })
    const review = computeHarness(stageEvent(), dir, 't')
    const plan = computeHarness(stageEvent({ stage: 'plan', payload: { ...stageEvent().payload, invocations: [] } }), dir, 't')
    expect(review.digest).not.toBe(plan.digest)
    expect(review.install).toBe(plan.install)
    install(dir, { 'commands/osm/plan.md': 'plan v2' })
    const after = computeHarness(stageEvent(), dir, 't')
    expect(after.digest).toBe(review.digest)
    expect(after.install).not.toBe(review.install)
  })
})
