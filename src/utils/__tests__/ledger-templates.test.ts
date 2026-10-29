import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { getAllCommandIds, installWorkflows } from '../installer'
import { PACKAGE_ROOT } from '../installer-template'
import { PARAMS } from '../ledger/params'

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
