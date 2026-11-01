import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { getAllCommandIds, installWorkflows } from '../installer'
import { PACKAGE_ROOT } from '../installer-template'
import { PRACTICES } from '../ledger/dimensions'
import { PARAMS } from '../ledger/params'
import { CHANGE_KINDS, DIMENSIONS } from '../ledger/schema'
import { recommendedIndex } from '../ledger/store'

const read = (rel: string) => readFileSync(join(PACKAGE_ROOT, 'templates', rel), 'utf8')
const ledger = read('prompts/claude/osm-ledger.md')

describe('templates state the same numbers as PARAMS', () => {
  it('probe budget, brief lines, adoption bar and display caps', () => {
    const p = PARAMS.probe
    const a = PARAMS.lessons.adopt
    expect(ledger).toContain(`fewer than **${p.perChange}** in this change`)
    expect(ledger).toContain(`fewer than **${p.perSession}** in this session`)
    expect(ledger).toContain(`fewer than **${p.perLessonPerChange}** probes in this change`)
    expect(ledger).toContain(`at most **${p.maxAdoptedLinesPerBrief}** \`adopted\` lines`)
    expect(ledger).toContain(`ask at W≥${a.minWins}, W−L≥${a.minMargin}, wins from ≥${a.minChanges} changes`)
    expect(ledger).toContain(`show at most ${p.displayMaxLines} lines`)
    expect(ledger).toContain(`at most ${p.blindInterdiffMaxLines} lines`)
    expect(ledger).toContain(`It prints at most ${PARAMS.lessons.queryDefault} lines`)
    expect(read('commands/impl.md')).toContain(`add at most ${p.maxAdoptedLinesPerBrief} adopted lines`)
  })

  it('uses the decision ids and option ids the CLI and H-rules expect', () => {
    for (const s of ['`with-lesson`, `without-lesson` and `cant-tell`', '`reveal-<id>`', '`reveal-global-<id>`', '`adopt`, `keep-trial`, `retire`', '"critical: <finding id>"']) expect(ledger).toContain(s)
  })

  it('keeps the blind-review rule and never hands the library to workers', () => {
    expect(ledger).toContain('none of the words main, comparison, champion or challenger')
    expect(read('commands/research.md')).toContain('never pass lessons to external models here')
    expect(read('commands/plan.md')).toContain('never pass lessons to external models here')
  })
})

describe('installed ledger prompts', () => {
  it('installs osm-ledger.md next to osm-report.md with ~/.claude rewritten', async () => {
    const installDir = join(tmpdir(), `osm-tpl-${Date.now()}`, '.claude')
    await fs.ensureDir(join(installDir, 'bin'))
    await fs.writeFile(join(installDir, 'bin', 'codeagent-wrapper'), '#!/usr/bin/env node\nconsole.log("codeagent-wrapper version 5.15.0")\n', { mode: 0o755 })
    await installWorkflows(getAllCommandIds(), installDir, true, { mcpProvider: 'skip' })
    const installed = readFileSync(join(installDir, '.ccg', 'prompts', 'claude', 'osm-ledger.md'), 'utf8')
    expect(installed).toContain(`${installDir}/bin/osm ledger lessons query`)
    expect(readFileSync(join(installDir, 'commands', 'osm', 'impl.md'), 'utf8')).toContain(`${installDir}/.ccg/prompts/claude/osm-ledger.md`)
  }, 60_000)
})

describe('Q18: report template budget and vocabularies', () => {
  const report = read('prompts/claude/osm-report.md')

  it('stays within 5,200 bytes and lists the schema enums exactly', () => {
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(5200)
    const dims = report.match(/`dimension` is one of (.*?) \(lesson adoption: `adoption`\)/)![1]
    expect([...dims.matchAll(/`([a-z]+)`/g)].map(m => m[1]).concat('adoption').sort()).toEqual([...DIMENSIONS].sort())
    expect(report.match(/`practices` from `([^`]+)`/)![1].split(', ')).toEqual([...PRACTICES])
    for (const t of [report, ledger]) expect(t.match(/`(feature \| fix[^`]*)`/)![1].split(' | ')).toEqual([...CHANGE_KINDS])
  })

  it('every JSON example appends with exit 0 through the CLI', () => {
    const run = '0f0e0d0c-0b0a-4908-8706-050403020100'
    let slug = 'q0'
    for (let i = 0; recommendedIndex(run, slug, 2) !== 1; i++) slug = `q${i}`
    const fill = (j: string) => j.replaceAll('<run id>', run).replaceAll('<change id or null>', 'c1').replaceAll('<change id>', 'c1').replaceAll('<change>', 'c1')
      .replaceAll('<question slug>', slug).replaceAll('<≤200 chars>', 'topic').replaceAll('<phase>', '1').replaceAll('<sha>', 'abc').replaceAll('<task>', 't1').replaceAll('<lesson>', 'L-0007')
    const examples = [report, ledger].flatMap(t => [...t.matchAll(/append <<'JSON'\n([\s\S]*?)\nJSON/g)].map(m => fill(m[1])))
    expect(examples.length).toBeGreaterThanOrEqual(4)
    const home = mkdtempSync(join(tmpdir(), 'osm-tpl-home-'))
    mkdirSync(join(home, 'p', 'openspec'), { recursive: true })
    const tsx = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')
    // The outcome example targets an impl phase of the change; give it one.
    const seed = JSON.stringify({ schema_version: 1, run_id: run, change_id: 'c1', stage: 'impl', phase_id: '1', kind: 'stage_completed', operation_key: 'report-1', payload: { status: 'completed', confidence: { percent: 70 }, verify: 'passed', invocations: [] } })
    for (const json of [seed, ...examples]) {
      expect(json, json).not.toMatch(/<[^>]+>/)
      const r = spawnSync(process.execPath, ['--import', `file://${tsx}`, join(PACKAGE_ROOT, 'src', 'cli.ts'), 'ledger', 'append'], { cwd: join(home, 'p'), input: json, env: { ...process.env, HOME: home, OSM_LEDGER: '' }, encoding: 'utf8' })
      expect(r.status, `${json}\n${r.stderr}`).toBe(0)
      expect(JSON.parse(r.stdout).status).toBe('appended')
    }
  }, 120_000)
})
