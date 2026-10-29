import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { projectLog } from '../paths'
import { resolveProject } from '../project'
import { appendEvent, readLog } from '../store'
import { stageEvent, tmp } from './fixtures'

const here = dirname(fileURLToPath(import.meta.url))

describe('scale', () => {
  it('appends to a 100k-event log with 4 concurrent writers and no lock timeouts', async () => {
    const base = tmp()
    const projectRoot = join(base, 'proj')
    mkdirSync(join(projectRoot, 'openspec'), { recursive: true })
    const root = join(base, 'ledger')
    const opts = { root, installDir: join(base, 'claude'), projectRoot, version: 't', env: {} }
    appendEvent(stageEvent(), opts)
    const log = projectLog(root, resolveProject(projectRoot).id)
    const template = readLog(log).events[0]
    const lines: string[] = []
    for (let i = 1; i <= 100_000; i++) lines.push(JSON.stringify({ ...template, event_id: i.toString(16).padStart(16, '0'), seq: i, operation_key: `bulk-${i}` }))
    writeFileSync(log, `${lines.join('\n')}\n`)

    const script = join(base, 'writer.mts')
    writeFileSync(script, `
      import { appendEvent } from ${JSON.stringify(join(here, '..', 'store.ts'))}
      import { stageEvent } from ${JSON.stringify(join(here, 'fixtures.ts'))}
      const r = appendEvent(stageEvent({ operation_key: 'new-' + process.argv[2] }), ${JSON.stringify(opts)})
      process.exit(r.code)
    `)
    const codes = await Promise.all([0, 1, 2, 3].map(n => new Promise<number>((resolve) => {
      spawn(process.execPath, ['--import', 'tsx', script, String(n)], { stdio: 'inherit' }).on('exit', c => resolve(c ?? -1))
    })))
    expect(codes).toEqual([0, 0, 0, 0])
    const { events, invalid } = readLog(log)
    expect(invalid).toBe(0)
    expect(events.slice(-4).map(e => e.seq)).toEqual([100_001, 100_002, 100_003, 100_004])
  }, 120_000)
})
