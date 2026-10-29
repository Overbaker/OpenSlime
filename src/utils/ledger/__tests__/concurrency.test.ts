import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { projectLog } from '../paths'
import { resolveProject } from '../project'
import { readLog } from '../store'
import { tmp } from './fixtures'

const here = dirname(fileURLToPath(import.meta.url))

function run(script: string, arg: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, arg], { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', reject)
    child.on('exit', code => resolve(code ?? -1))
  })
}

describe('P3: concurrent appends', () => {
  it('32 writers with overlapping identities produce complete distinct lines in strictly increasing seq', async () => {
    const base = tmp()
    const projectRoot = join(base, 'proj')
    mkdirSync(join(projectRoot, 'openspec'), { recursive: true })
    const root = join(base, 'ledger')
    const script = join(base, 'writer.mts')
    writeFileSync(script, `
      import { appendEvent } from ${JSON.stringify(join(here, '..', 'store.ts'))}
      import { stageEvent } from ${JSON.stringify(join(here, 'fixtures.ts'))}
      const n = Number(process.argv[2])
      const r = appendEvent(stageEvent({ operation_key: 'k' + (n % 24) }), { root: ${JSON.stringify(root)}, installDir: ${JSON.stringify(join(base, 'claude'))}, projectRoot: ${JSON.stringify(projectRoot)}, version: 't', env: {} })
      process.exit(r.code)
    `)
    const codes = await Promise.all(Array.from({ length: 32 }, (_, i) => run(script, String(i))))
    expect(codes.every(c => c === 0)).toBe(true)
    const { events, invalid } = readLog(projectLog(root, resolveProject(projectRoot).id))
    expect(invalid).toBe(0)
    expect(events).toHaveLength(24)
    expect(new Set(events.map(e => e.event_id)).size).toBe(24)
    expect(events.map(e => e.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
  }, 60_000)
})
