import type { DoctorDependencies } from '../../utils/doctor-checks'
import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'smol-toml'
import { doctor } from '../doctor'
import { collectDoctorReport } from '../../utils/doctor-checks'
import { installSkills } from '../../utils/skill-manager'

let home: string
let exec: ReturnType<typeof vi.fn>
function deps(extra: DoctorDependencies = {}): DoctorDependencies {
  return { home, nodeVersion: 'v22.0.0', platform: 'darwin', exec, ...extra }
}
async function config(frontend = 'claude', backend = 'claude', review = ['claude']) {
  await fs.outputFile(join(home, '.claude', '.ccg', 'config.toml'), stringify({
    general: { version: '3.6.8', language: 'zh-CN' },
    routing: { frontend: { primary: frontend, models: [frontend] }, backend: { primary: backend, models: [backend] }, review: { models: review } },
  }))
}
async function claudeInstall() {
  await fs.outputFile(join(home, '.claude', 'commands', 'osm', 'plan.md'), '# CCG')
  await fs.outputJSON(join(home, '.claude', 'settings.json'), { env: { SECRET_TOKEN: 'super-secret-value' } })
  await fs.outputFile(join(home, '.claude', 'rules', 'ccg-codegraph.md'), 'rule')
}
async function codexInstall() {
  await fs.outputFile(join(home, '.codex', '.ccg-version'), '3.6.8')
  await fs.outputFile(join(home, '.codex', 'config.toml'), '[features]\nfixture = true\n')
  await fs.outputFile(join(home, '.codex', 'AGENTS.md'), '<!-- CCG:START -->\nCCG')
  for (const file of ['agents/ccg-implement.toml', 'agents/ccg-review.toml', 'agents/ccg-research.toml', 'hooks/ccg-workflow.py']) {
    await fs.outputFile(join(home, '.codex', file), 'managed')
  }
  await fs.outputJSON(join(home, '.codex', 'hooks.json'), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `python3 "${join(home, '.codex', 'hooks', 'ccg-workflow.py')}"` }] }] } })
  await fs.outputFile(join(home, '.claude', 'bin', 'codeagent-wrapper'), 'binary')
}
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ccg-doctor-'))
  exec = vi.fn(() => 'tool version 1.2.3')
})
afterEach(async () => { await fs.remove(home) })

describe('CCG doctor inventory', () => {
  it('does not treat unrelated Codex AGENTS.md or a non-version marker as installed', async () => {
    await fs.outputFile(join(home, '.codex', 'AGENTS.md'), '# User rules')
    await fs.outputFile(join(home, '.codex', '.ccg-version'), 'unrelated')
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('none')
    expect(report.checks.find(c => c.id === 'installation.mode')?.status).toBe('fail')
    expect(exec).not.toHaveBeenCalled()
  })

  it('checks pure Claude mode without external model CLIs or the wrapper', async () => {
    await config()
    await claudeInstall()
    exec.mockReturnValue(null)
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('claude')
    expect(report.failureCount).toBe(0)
    expect(report.checks.find(c => c.id === 'routing.pure-claude')?.status).toBe('pass')
    expect(exec).not.toHaveBeenCalled()
  })

  it('recognizes bundled nested skills without the retired root index', async () => {
    await config()
    await claudeInstall()
    await fs.outputFile(join(home, '.claude', 'skills', 'ccg', 'domains', 'frontend-design', 'SKILL.md'), '# Skill')
    const report = await collectDoctorReport(deps())
    expect(report.checks.find(c => c.id === 'claude.skills')).toMatchObject({ status: 'pass', detail: 'Legacy bundled skills found' })
  })

  it('includes review-only backends and reports missing selected CLI only', async () => {
    await config('claude', 'claude', ['codex', 'gemini'])
    await claudeInstall()
    exec.mockImplementation((file: string) => file === 'codex' ? null : '1.2.3')
    const report = await collectDoctorReport(deps())
    expect(report.backends).toEqual(['claude', 'codex', 'gemini'])
    expect(report.checks.find(c => c.id === 'cli.codex')?.status).toBe('fail')
    expect(report.checks.find(c => c.id === 'cli.gemini')?.status).toBe('pass')
    expect(exec.mock.calls.map(call => call[0])).toEqual(['claude', 'codex', 'gemini'])
    expect(report.checks.some(c => c.id === 'cli.grok')).toBe(false)
  })

  it.each([
    undefined,
    '{invalid',
    '{}',
    'null',
    '{"permissions":{"allow":"command(*)"}}',
    '{"permissions":{"allow":[null,42,"read(*)"]}}',
    '{"permissions":{"allow":["command(git status)"]}}',
  ])('warns without changing missing or invalid Antigravity permissions: %s', async (content) => {
    await config('antigravity')
    await claudeInstall()
    await fs.outputFile(join(home, '.claude', 'bin', 'codeagent-wrapper'), 'binary')
    const path = join(home, '.gemini', 'antigravity-cli', 'settings.json')
    if (content !== undefined) await fs.outputFile(path, content)
    const report = await collectDoctorReport(deps())
    expect(report.failureCount).toBe(0)
    expect(report.checks.find(c => c.id === 'antigravity.permissions')).toMatchObject({
      status: 'warn',
      remediation: 'Allow agy shell tools in headless mode: add "command(*)" to permissions.allow in ~/.gemini/antigravity-cli/settings.json (ask the user first).',
    })
    if (content === undefined) expect(await fs.pathExists(path)).toBe(false)
    else expect(await fs.readFile(path, 'utf8')).toBe(content)
  })

  it.each(['command(*)'])('accepts %s for review-only Antigravity using the injected Gemini directory', async (rule) => {
    await config('claude', 'claude', ['antigravity'])
    await claudeInstall()
    const geminiDir = join(home, 'custom-gemini')
    const path = join(geminiDir, 'antigravity-cli', 'settings.json')
    const content = JSON.stringify({ permissions: { allow: ['read(*)', rule] } })
    await fs.outputFile(path, content)
    const report = await collectDoctorReport(deps({ geminiDir }))
    expect(report.checks.find(c => c.id === 'antigravity.permissions')).toMatchObject({ status: 'pass', remediation: null })
    expect(await fs.readFile(path, 'utf8')).toBe(content)
    expect(await fs.pathExists(join(home, '.gemini'))).toBe(false)
  })

  it('omits the Antigravity permission check when that backend is not selected', async () => {
    await config()
    await claudeInstall()
    const report = await collectDoctorReport(deps())
    expect(report.checks.some(c => c.id === 'antigravity.permissions')).toBe(false)
    expect(await fs.pathExists(join(home, '.gemini'))).toBe(false)
  })

  it('checks Codex artifacts without requiring Claude hooks or commands', async () => {
    await codexInstall()
    await config('codex', 'codex', ['codex'])
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('codex')
    expect(report.failureCount).toBe(0)
    expect(report.checks.some(c => c.id === 'claude.hooks')).toBe(false)
    expect(report.checks.find(c => c.id === 'codex.hook-registration')?.status).toBe('pass')
  })

  it('checks standalone Codex host without treating absent Claude config or delegation tools as damaged', async () => {
    await codexInstall()
    await fs.remove(join(home, '.claude'))
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('codex')
    expect(report.failureCount).toBe(0)
    expect(report.backends).toEqual(['codex'])
    expect(report.checks.find(c => c.id === 'config')?.status).toBe('skip')
    expect(report.checks.find(c => c.id === 'binary.wrapper')).toMatchObject({ status: 'warn', detail: expect.stringContaining('unavailable') })
    expect(report.checks.find(c => c.id === 'codex.role-prompts')?.status).toBe('warn')
    expect(exec.mock.calls.map(call => call[0])).toEqual(['codex'])
    exec.mockReturnValue(null)
    const missingHost = await collectDoctorReport(deps())
    expect(missingHost.checks.find(c => c.id === 'cli.codex')?.status).toBe('fail')
  })

  it('still requires Claude config in both modes and valid Codex artifacts in standalone mode', async () => {
    await codexInstall()
    await claudeInstall()
    const both = await collectDoctorReport(deps())
    expect(both.mode).toBe('both')
    expect(both.checks.find(c => c.id === 'config')?.status).toBe('fail')
    await fs.remove(join(home, '.claude'))
    await fs.outputFile(join(home, '.codex', 'config.toml'), 'invalid = "unterminated')
    const malformed = await collectDoctorReport(deps())
    expect(malformed.checks.find(c => c.id === 'codex.config')?.status).toBe('fail')
  })

  it('checks installed Codex delegation drivers as warnings and shows remediation in text', async () => {
    await codexInstall()
    await fs.remove(join(home, '.claude'))
    await fs.outputFile(join(home, '.codex', 'AGENTS.md'), '<!-- CCG:START -->\n--backend antigravity\n--backend claude\n')
    exec.mockImplementation((file: string) => file === 'codex' ? '1.2.3' : null)
    const output = vi.fn()
    const report = await doctor({}, deps({ output, setExitCode: vi.fn() }))
    expect(report.failureCount).toBe(0)
    expect(report.checks.find(c => c.id === 'cli.delegation.antigravity')?.status).toBe('warn')
    expect(report.checks.find(c => c.id === 'antigravity.permissions')?.status).toBe('warn')
    expect(report.checks.find(c => c.id === 'cli.delegation.claude')?.status).toBe('warn')
    const text = output.mock.calls.map(call => call[0]).join('\n')
    expect(text).toContain(`No failures; ${report.warningCount} warning(s).`)
    expect(text).toContain('Run ccg init')
    expect(text).not.toContain('All checks passed.')
  })

  it('fails malformed config and unknown backend without echoing config content', async () => {
    await config('codex', 'secret-unknown-backend')
    await claudeInstall()
    const unknown = await collectDoctorReport(deps())
    expect(unknown.checks.find(c => c.id === 'routing.backends')?.status).toBe('fail')
    expect(JSON.stringify(unknown)).not.toContain('secret-unknown-backend')
    await fs.outputFile(join(home, '.claude', '.ccg', 'config.toml'), 'secret-token = "unterminated')
    const malformed = await collectDoctorReport(deps())
    expect(malformed.checks.find(c => c.id === 'config')?.status).toBe('fail')
    expect(JSON.stringify(malformed)).not.toContain('secret-token')
  })


  it('outputs standalone JSON without ANSI or secrets and sets nonzero failure exit code', async () => {
    await config()
    await claudeInstall()
    const output = vi.fn()
    const setExitCode = vi.fn()
    const healthy = await doctor({ json: true }, deps({ output, setExitCode }))
    expect(output).toHaveBeenCalledTimes(1)
    const text = output.mock.calls[0][0]
    expect(JSON.parse(text)).toEqual(healthy)
    expect(text).not.toContain('\x1B')
    expect(text).not.toContain('super-secret-value')
    expect(healthy.schemaVersion).toBe(1)
    expect(setExitCode).toHaveBeenLastCalledWith(0)
    await fs.remove(join(home, '.claude', 'commands', 'osm'))
    await doctor({ json: true }, deps({ output, setExitCode }))
    expect(setExitCode).toHaveBeenLastCalledWith(1)
  })

  it('uses platform-specific Windows npm shims and native executables', async () => {
    await config('antigravity', 'codex', ['gemini', 'claude', 'kimi', 'grok', 'opencode'])
    await claudeInstall()
    await collectDoctorReport(deps({ platform: 'win32' }))
    expect(exec.mock.calls.map(call => call[0])).toEqual(['agy.exe', 'claude.exe', 'codex.cmd', 'gemini.cmd', 'grok.exe', 'kimi.exe', 'opencode.exe'])
    expect(exec.mock.calls.every(call => JSON.stringify(call[1]) === '["--version"]')).toBe(true)
  })

  it('marks a corrupt native skill manifest as failure and legacy skills as warnings', async () => {
    await config()
    await claudeInstall()
    await fs.outputFile(join(home, '.claude', 'skills', 'ccg', 'SKILL.md'), '# Legacy CCG')
    const legacy = await collectDoctorReport(deps())
    expect(legacy.checks.find(c => c.id === 'claude.skills')?.status).toBe('warn')
    await fs.ensureDir(join(home, '.claude', 'skills'))
    await fs.outputFile(join(home, '.claude', '.ccg-skills', 'manifest.json'), 'invalid-json')
    const corrupt = await collectDoctorReport(deps())
    expect(corrupt.checks.find(c => c.id === 'claude.skills')?.status).toBe('fail')
  })

  it('allows healthy skills-only installs without requiring routing, commands, hooks or model CLIs', async () => {
    const templatesDir = join(home, 'templates')
    await fs.outputFile(join(templatesDir, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: Sample native skill\n---\n# Sample\n')
    const paths = { templatesDir, nativeDir: join(home, '.agents', 'skills'), storeDir: join(home, '.agents', '.ccg-skills') }
    await installSkills(['sample'], { target: 'codex', ...paths })
    const report = await collectDoctorReport(deps({ skillPaths: { codex: paths } }))
    expect(report.mode).toBe('skills')
    expect(report.failureCount).toBe(0)
    expect(report.checks.find(c => c.id === 'codex.skills')).toMatchObject({ status: 'pass', detail: '1/1 managed skills healthy' })
    expect(report.checks.some(c => c.id === 'binary.wrapper' || c.id === 'claude.hooks')).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})
