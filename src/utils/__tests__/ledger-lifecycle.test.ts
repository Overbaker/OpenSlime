import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { collectDoctorReport } from '../doctor-checks'
import { getAllCommandIds, installWorkflows, uninstallWorkflows } from '../installer'
import { PACKAGE_ROOT } from '../installer-template'
import { shimTarget } from '../ledger/shim'

function manifest(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${p} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
    }
  }
  walk(dir)
  return out.join('\n')
}

async function prepareWrapper(installDir: string): Promise<void> {
  await fs.ensureDir(join(installDir, 'bin'))
  if (process.platform !== 'win32') await fs.writeFile(join(installDir, 'bin', 'codeagent-wrapper'), '#!/usr/bin/env node\nconsole.log("codeagent-wrapper version 5.15.0")\n', { mode: 0o755 })
}

describe('P13: install, force-install and uninstall preserve the ledger', () => {
  it('leaves ~/.claude/osm-ledger byte-identical, writes and removes the shim', async () => {
    const installDir = join(tmpdir(), `osm-life-${Date.now()}`, '.claude')
    const ledger = join(installDir, 'osm-ledger')
    await fs.outputFile(join(ledger, 'projects', 'p_0123456789abcdef', 'events.jsonl'), '{"event_id":"a","seq":1}\n')
    await fs.outputFile(join(ledger, 'projects', 'p_0123456789abcdef', 'lessons', 'entries', 'L-0001.md'), '---\nid: "L-0001"\n---\n')
    await fs.outputFile(join(ledger, 'disabled'), '')
    const before = manifest(ledger)
    await prepareWrapper(installDir)

    expect((await installWorkflows(getAllCommandIds(), installDir, true, { mcpProvider: 'skip' })).errors).toEqual([])
    expect(await shimTarget(installDir)).toBe(join(PACKAGE_ROOT, 'bin', 'ccg.mjs'))
    await installWorkflows(getAllCommandIds(), installDir, true, { mcpProvider: 'skip' })
    expect(manifest(ledger)).toBe(before)

    const doctor = await collectDoctorReport({ home: join(installDir, '..'), installDir })
    expect(doctor.checks.find(c => c.id === 'ledger.shim')).toMatchObject({ status: 'pass', detail: expect.stringContaining('recording off') })

    const result = await uninstallWorkflows(installDir)
    expect(result).toMatchObject({ removedShim: true, ledgerPreserved: ledger })
    expect(await shimTarget(installDir)).toBeNull()
    expect(manifest(ledger)).toBe(before)

    const after = await collectDoctorReport({ home: join(installDir, '..'), installDir })
    expect(after.checks.find(c => c.id === 'ledger.shim')).toBeUndefined()
  }, 60_000)

  it('no slimmed artifact can retire the ledger', () => {
    const src = readFileSync(join(PACKAGE_ROOT, 'src', 'utils', 'installer.ts'), 'utf8')
    const start = src.indexOf('const SLIMMED_ARTIFACTS')
    const block = src.slice(start, src.indexOf('\n]', start))
    expect(block).toContain('rules')
    expect(block).not.toMatch(/osm-ledger|'bin'|"bin"/)
  })

  it.runIf(process.platform !== 'win32')('doctor warns, never fails, when the shim points to a missing checkout', async () => {
    const installDir = join(tmpdir(), `osm-doc-${Date.now()}`, '.claude')
    await prepareWrapper(installDir)
    await installWorkflows(getAllCommandIds(), installDir, true, { mcpProvider: 'skip' })
    await fs.writeFile(join(installDir, 'bin', 'osm'), `#!/bin/sh\nexec '${process.execPath}' '/gone/bin/ccg.mjs' "$@"\n`)
    const report = await collectDoctorReport({ home: join(installDir, '..'), installDir })
    expect(report.checks.find(c => c.id === 'ledger.shim')).toMatchObject({ status: 'warn', detail: expect.stringContaining('/gone/bin/ccg.mjs') })
  }, 60_000)
})

describe('doctor checks the Node binary in the shim', () => {
  it.runIf(process.platform !== 'win32')('warns when the Node binary is gone', async () => {
    const installDir = join(tmpdir(), `osm-node-${Date.now()}`, '.claude')
    await prepareWrapper(installDir)
    await installWorkflows(getAllCommandIds(), installDir, true, { mcpProvider: 'skip' })
    await fs.writeFile(join(installDir, 'bin', 'osm'), `#!/bin/sh\nexec '/gone/node' '${join(PACKAGE_ROOT, 'bin', 'ccg.mjs')}' "$@"\n`)
    const report = await collectDoctorReport({ home: join(installDir, '..'), installDir })
    expect(report.checks.find(c => c.id === 'ledger.shim')).toMatchObject({ status: 'warn', detail: expect.stringContaining('missing Node binary') })
  }, 60_000)
})
