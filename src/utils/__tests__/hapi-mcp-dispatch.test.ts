import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { getAllCommandIds, installWorkflows } from '../installer'
import { PACKAGE_ROOT } from '../installer-template'

const readTemplate = (rel: string) => readFileSync(join(PACKAGE_ROOT, 'templates', rel), 'utf8')

describe('HAPI MCP dispatch integration', () => {
  it('installs hapi-mcp.md next to osm-ledger.md with ~/.claude rewritten', async () => {
    const installDir = join(tmpdir(), `osm-hapi-mcp-${Date.now()}`, '.claude')
    await fs.ensureDir(join(installDir, 'bin'))
    await fs.writeFile(
      join(installDir, 'bin', 'codeagent-wrapper'),
      '#!/usr/bin/env node\nconsole.log("codeagent-wrapper version 5.16.0")\n',
      { mode: 0o755 },
    )

    await installWorkflows(getAllCommandIds(), installDir, true, { mcpProvider: 'skip' })

    const installedGuide = readFileSync(join(installDir, '.ccg', 'prompts', 'claude', 'hapi-mcp.md'), 'utf8')
    expect(installedGuide).toContain('mcp__hapi__spawn_peer')
    expect(installedGuide).toContain(`${installDir}/.ccg/prompts/`)

    for (const cmd of ['research', 'plan', 'impl', 'review']) {
      const commandDoc = readFileSync(join(installDir, 'commands', 'osm', `${cmd}.md`), 'utf8')
      expect(commandDoc).toContain(`${installDir}/.ccg/prompts/claude/hapi-mcp.md`)
    }
  }, 60_000)

  it('keeps hapi-mcp guidance outside wrapper heredocs', () => {
    for (const cmd of ['research', 'plan', 'impl', 'review']) {
      const raw = readTemplate(`commands/${cmd}.md`)
      expect(raw).toContain('hapi-mcp.md')
      expect(raw).toContain('--no-hapi-mcp')
    }
  })
})
