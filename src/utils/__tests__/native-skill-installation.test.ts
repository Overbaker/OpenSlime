import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import { installWorkflows, uninstallWorkflows } from '../installer'
import { installedNames, listSkills } from '../skill-manager'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(p => fs.remove(p))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ccg-native-install-'))
  directories.push(root)
  await fs.ensureDir(join(root, 'bin'))
  const binary = join(root, 'bin', 'codeagent-wrapper')
  await fs.writeFile(binary, '#!/usr/bin/env node\nconsole.log("codeagent-wrapper version 5.15.0")\n', { mode: 0o755 })
  return root
}

const paths = (root: string) => ({ target: 'claude' as const, nativeDir: join(root, 'skills'), storeDir: join(root, '.ccg-skills') })

describe('native skill integration', () => {
  it('installs only the selected native entry without routing rules, and uninstalls its alias', async () => {
    const root = await setup()
    const result = await installWorkflows(['plan'], root, true, {
      skillsProfile: ['scrapling'], mcpProvider: 'skip',
      routing: { frontend: { primary: 'grok' }, backend: { primary: 'opencode' }, opencodeModel: 'deepseek/model-example' },
    })
    expect(result.success).toBe(true)
    expect(result.installedSkills).toBe(1)
    expect(await installedNames(paths(root))).toEqual(['scrapling'])
    expect((await listSkills(paths(root))).filter(s => s.installed)).toMatchObject([{ name: 'scrapling', healthy: true }])
    expect(await fs.pathExists(join(root, 'skills', 'ccg'))).toBe(false)
    // Slim fork: native skills are host-discovered; nothing is injected per session or per turn
    expect(await fs.pathExists(join(root, 'rules', 'ccg-skill-routing.md'))).toBe(false)
    expect(await fs.pathExists(join(root, 'hooks', 'ccg'))).toBe(false)
    await fs.ensureDir(join(root, 'skills', 'my-own-skill'))
    await fs.writeFile(join(root, 'skills', 'my-own-skill', 'SKILL.md'), 'personal')
    const removed = await uninstallWorkflows(root)
    expect(removed.success).toBe(true)
    expect(removed.removedSkills).toContain('ccg-scrapling')
    expect(await fs.pathExists(join(root, 'skills', 'ccg-scrapling'))).toBe(false)
    expect(await fs.readFile(join(root, 'skills', 'my-own-skill', 'SKILL.md'), 'utf8')).toBe('personal')
    expect(await fs.pathExists(join(root, '.ccg-skills', 'snapshots'))).toBe(true)
  }, 30_000)

  it('explicit compatibility mode disables managed aliases and preserves their cache', async () => {
    const root = await setup()
    await installWorkflows(['plan'], root, true, { skillsProfile: ['scrapling'], mcpProvider: 'skip' })
    const result = await installWorkflows(['plan'], root, true, { skillsMode: 'legacy', mcpProvider: 'skip' })
    expect(result.success).toBe(true)
    expect(await installedNames(paths(root))).toEqual([])
    expect(await fs.pathExists(join(root, 'skills', 'ccg-scrapling'))).toBe(false)
    expect(await fs.pathExists(join(root, 'skills', 'ccg', 'scrapling', 'SKILL.md'))).toBe(true)
    expect(await fs.pathExists(join(root, '.ccg-skills', 'snapshots'))).toBe(true)
  }, 30_000)

  it('returns an installation failure while preserving a conflicting user skill', async () => {
    const root = await setup()
    await fs.ensureDir(join(root, 'skills', 'ccg-scrapling'))
    const userFile = join(root, 'skills', 'ccg-scrapling', 'SKILL.md')
    await fs.writeFile(userFile, 'user-owned')
    const result = await installWorkflows(['plan'], root, true, { skillsProfile: ['scrapling'], mcpProvider: 'skip' })
    expect(result.success).toBe(false)
    expect(result.errors.join('\n')).toMatch(/conflict|ownership|preserved/i)
    expect(await fs.readFile(userFile, 'utf8')).toBe('user-owned')
  }, 30_000)

  it('removes hooks, routing rules and dropped files left by a full install, keeping user hooks', async () => {
    const root = await setup()
    await fs.ensureDir(join(root, 'hooks', 'ccg'))
    await fs.writeFile(join(root, 'hooks', 'ccg', 'skill-router.js'), '')
    await fs.ensureDir(join(root, 'rules'))
    for (const name of ['ccg-skills.md', 'ccg-skill-routing.md', 'my-rule.md'])
      await fs.writeFile(join(root, 'rules', name), 'x')
    await fs.ensureDir(join(root, 'commands', 'ccg'))
    await fs.writeFile(join(root, 'commands', 'ccg', 'go.md'), 'x')
    await fs.ensureDir(join(root, '.ccg', 'engine'))
    await fs.writeJson(join(root, 'settings.json'), { hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: `node ${join(root, 'hooks', 'ccg', 'skill-router.js')}` }] },
        { hooks: [{ type: 'command', command: 'echo mine' }] },
      ],
      SessionStart: [{ matcher: 'startup', hooks: [
        { type: 'command', command: `node ${join(root, 'hooks', 'ccg', 'session-start.js')}` },
        { type: 'command', command: 'echo shared' },
      ] }],
    } })
    const result = await installWorkflows(['plan'], root, true, { skillsProfile: [], mcpProvider: 'skip' })
    expect(result.success).toBe(true)
    for (const rel of ['hooks/ccg', 'rules/ccg-skills.md', 'rules/ccg-skill-routing.md', 'commands/ccg', '.ccg/engine'])
      expect(await fs.pathExists(join(root, rel))).toBe(false)
    expect(await fs.pathExists(join(root, 'rules', 'my-rule.md'))).toBe(true)
    expect(await fs.pathExists(join(root, 'commands', 'osm', 'plan.md'))).toBe(true)
    expect((await fs.readJson(join(root, 'settings.json'))).hooks).toEqual({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo shared' }] }],
    })
    // Retired files are moved aside, not deleted
    const [stamp] = await fs.readdir(join(root, '.ccg-retired'))
    expect(await fs.readFile(join(root, '.ccg-retired', stamp, 'commands', 'ccg', 'go.md'), 'utf8')).toBe('x')
  }, 30_000)
})
