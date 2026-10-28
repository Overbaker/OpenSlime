import { mkdtemp, mkdir, writeFile, readFile, symlink, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { init } from '../../commands/init'
import { createDefaultConfig, createDefaultRouting } from '../config'
import { injectConfigVariables } from '../installer-template'
import { promptOpencodeModel, validateOpencodeModel } from '../model-selection'

const mocks = vi.hoisted(() => ({
  existing: null as any,
  writeConfig: vi.fn(),
  install: vi.fn(),
  prompt: vi.fn(),
  pathExists: vi.fn(),
  installedNames: vi.fn(),
  removeSkills: vi.fn(),
  spinnerFailed: vi.fn(),
  spinnerSucceeded: vi.fn(),
  installMcp: vi.fn(),
}))

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt, Separator: class {} } }))
vi.mock('fs-extra', async () => {
  const actual = await vi.importActual<{ default: typeof import('fs-extra') }>('fs-extra')
  return { default: { ...actual.default, pathExists: mocks.pathExists, writeJSON: vi.fn() } }
})
vi.mock('ora', () => ({
  default: () => ({ start() { return this }, succeed: mocks.spinnerSucceeded, fail: mocks.spinnerFailed }),
}))
vi.mock('../../i18n', () => ({ i18n: { t: (key: string) => key }, initI18n: vi.fn() }))
vi.mock('../migration', () => ({ needsMigration: vi.fn().mockResolvedValue(false), migrateToV1_4_0: vi.fn() }))
vi.mock('../config', async () => ({
  ...await vi.importActual<typeof import('../config')>('../config'),
  readCcgConfig: () => Promise.resolve(mocks.existing),
  writeCcgConfig: mocks.writeConfig,
  ensureCcgDir: vi.fn(),
}))
vi.mock('../installer', () => ({
  getCoreCommandIds: () => ['go'],
  getAllCommandIds: () => ['go', 'plan'],
  installWorkflows: mocks.install,
  sponsorInquirerChoices: () => [],
  showBinaryDownloadWarning: vi.fn(),
  configureGeminiCliApi: vi.fn(),
  configureSponsorForCodex: vi.fn(),
  getSponsor: vi.fn(),
  installAceTool: vi.fn(),
  installAceToolRs: vi.fn(),
  installContextWeaver: vi.fn(),
  installFastContext: vi.fn(),
  installMcpServer: mocks.installMcp,
  promptSponsorInit: vi.fn(),
  syncMcpToCodex: vi.fn(),
  syncMcpToGemini: vi.fn(),
  writeFastContextPrompt: vi.fn(),
}))
vi.mock('../skill-manager', () => ({
  resolveSkillPaths: (options: any) => ({
    target: 'claude', nativeDir: '/tmp/ccg-default/skills', storeDir: '/tmp/ccg-default/.ccg-skills', ...options,
  }),
  SKILL_MANIFEST_FILE: 'manifest.json',
  installedNames: mocks.installedNames,
  removeSkills: mocks.removeSkills,
  getSkillCatalog: () => [
    { name: 'verify-change', description: 'Review changes' },
    { name: 'multi-agent', description: 'Coordinate agents' },
  ],
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pathExists.mockResolvedValue(false)
  mocks.installedNames.mockResolvedValue([])
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.existing = createDefaultConfig({
    language: 'en',
    routing: {
      ...createDefaultRouting(),
      backend: { models: ['opencode'], primary: 'opencode', strategy: 'fallback' },
      opencodeModel: 'deepseek/custom-test-model',
    },
    installedWorkflows: ['go'],
    mcpProvider: 'skip',
  })
  mocks.install.mockResolvedValue({ success: true, installedCommands: [], installedPrompts: [], errors: [] })
})
afterEach(() => {
  expect(console.error).not.toHaveBeenCalled()
  process.exitCode = undefined
  vi.restoreAllMocks()
})

function answerInitQuestions(overrides: Record<string, any> = {}) {
  mocks.prompt.mockImplementation(async (questions: any[]) => {
    const name = questions[0].name
    const answers: Record<string, any> = {
      apiProvider: 'skip', wireGeminiCli: false,
      selectedFrontend: 'codex', selectedBackend: 'opencode',
      selectedOpencodeModel: questions[0].default,
      skillsMode: 'legacy', action: 'confirm',
      ...overrides,
    }
    if (!(name in answers))
      throw new Error(`Unexpected prompt: ${name}`)
    return { [name]: answers[name] }
  })
}

describe('OpenCode configuration during init', () => {
  it('preserves the model during a non-interactive reinstall and injects it into execution templates', async () => {
    await init({ skipPrompt: true, skipMcp: true, force: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig).toHaveBeenCalledTimes(1)
    const config = mocks.writeConfig.mock.calls[0][0]
    expect(config.routing.opencodeModel).toBe('deepseek/custom-test-model')
    const installOptions = mocks.install.mock.calls[0][3]
    const command = injectConfigVariables('wrapper --backend {{BACKEND_PRIMARY}} {{OPENCODE_MODEL_FLAG}}task', installOptions)
    expect(command).toContain('--backend opencode --opencode-model deepseek/custom-test-model task')
    expect(mocks.prompt).not.toHaveBeenCalled()
  })

  it('uses the saved model as the interactive default even when MCP configuration is skipped', async () => {
    answerInitQuestions()
    await init({ skipMcp: true, force: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig).toHaveBeenCalledTimes(1)
    expect(mocks.writeConfig.mock.calls[0][0].routing.opencodeModel).toBe('deepseek/custom-test-model')
    const question = mocks.prompt.mock.calls.flatMap(([questions]) => questions).find(q => q.name === 'selectedOpencodeModel')
    expect(question.default).toBe('deepseek/custom-test-model')
  })

  it('shows saved native Skills as checked and saves only the explicit custom selection', async () => {
    mocks.existing.performance.skillsProfile = ['verify-change']
    answerInitQuestions({ skillsMode: 'custom', selectedSkills: ['multi-agent'] })
    await init({ skipMcp: true, force: true, installDir: '/tmp/ccg-init-test' })
    const question = mocks.prompt.mock.calls.flatMap(([questions]) => questions).find(q => q.name === 'selectedSkills')
    expect(question.choices).toEqual([
      { name: 'verify-change — Review changes', value: 'verify-change', checked: true },
      { name: 'multi-agent — Coordinate agents', value: 'multi-agent', checked: false },
    ])
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(['multi-agent'])
  })

  it('leaves the legacy profile implicit when no Skills selection has been configured', async () => {
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance).not.toHaveProperty('skillsProfile')
    expect(mocks.install.mock.calls[0][3].skillsProfile).toBeUndefined()
  })

  it.each([[undefined], [['verify-change']]])('uses the latest manifest rather than a stale profile %j', async (oldProfile) => {
    mocks.existing.performance.skillsProfile = oldProfile
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    mocks.installedNames.mockResolvedValue(['multi-agent'])
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(['multi-agent'])
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsMode).toBe('native')
    expect(mocks.installedNames).toHaveBeenCalledWith(expect.objectContaining({
      nativeDir: '/tmp/ccg-init-test/skills', storeDir: '/tmp/ccg-init-test/.ccg-skills',
    }))
  })

  it.each(['profile', 'manifest'])('filters retired names from a saved %s and removes managed aliases', async (source) => {
    mocks.existing.performance.skillsProfile = ['verify-security', 'verify-change']
    mocks.installedNames.mockResolvedValue(['verify-security', 'verify-change'])
    if (source === 'manifest')
      mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.removeSkills).toHaveBeenCalledWith(['verify-security'], expect.any(Object))
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(['verify-change'])
    expect(mocks.install.mock.calls[0][3].skillsProfile).toEqual(['verify-change'])
    expect(mocks.spinnerFailed).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'aborted'])('leaves the manifest and aliases untouched when init is %s', async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'ccg-cancel-init-'))
    const store = join(root, '.ccg-skills')
    const target = join(store, 'snapshots', 'retired')
    const alias = join(root, 'skills', 'ccg-verify-security')
    const manifestPath = join(store, 'manifest.json')
    const manifest = JSON.stringify({ skills: [{ name: 'verify-security', target }] })
    try {
      await mkdir(target, { recursive: true })
      await mkdir(join(root, 'skills'))
      await writeFile(manifestPath, manifest)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const originalTarget = await readlink(alias)
      mocks.existing.performance.skillsProfile = ['verify-security', 'verify-change']
      mocks.pathExists.mockImplementation(async (path: string) => path === manifestPath)
      mocks.installedNames.mockResolvedValue(['verify-security', 'verify-change'])
      answerInitQuestions({ skillsMode: 'custom', selectedSkills: ['verify-change'], action: 'cancel' })
      if (outcome === 'aborted')
        mocks.prompt.mockRejectedValueOnce(new Error('Prompt aborted'))
      const result = init({ skipMcp: true, installDir: root })
      if (outcome === 'aborted')
        await expect(result).rejects.toThrow('Prompt aborted')
      else
        await result
      expect(mocks.removeSkills).not.toHaveBeenCalled()
      expect(mocks.writeConfig).not.toHaveBeenCalled()
      expect(mocks.install).not.toHaveBeenCalled()
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
      expect(await readlink(alias)).toBe(originalTarget)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves an empty manifest selection after standalone removals', async () => {
    mocks.existing.performance.skillsProfile = ['verify-change']
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual([])
  })

  it('keeps an explicit legacy choice even if an older native manifest remains', async () => {
    mocks.existing.performance.skillsMode = 'legacy'
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.installedNames).not.toHaveBeenCalled()
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsMode).toBe('legacy')
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toBeUndefined()
  })

  it('refuses a damaged manifest without falling back to old configuration', async () => {
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    mocks.installedNames.mockRejectedValueOnce(new Error('Invalid managed skill record'))
    await expect(init({ skipPrompt: true, skipMcp: true })).rejects.toThrow('Invalid managed skill record')
    expect(mocks.writeConfig).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('explicit --skills overrides the manifest selection', async () => {
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    mocks.installedNames.mockResolvedValue(['multi-agent'])
    await init({ skipPrompt: true, skipMcp: true, skills: 'none', installDir: '/tmp/ccg-init-test' })
    expect(mocks.installedNames).not.toHaveBeenCalled()
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual([])
  })

  it('persists an explicit interactive legacy choice for later updates', async () => {
    mocks.existing.performance.skillsProfile = ['verify-change']
    answerInitQuestions({ skillsMode: 'legacy' })
    await init({ skipMcp: true, installDir: '/tmp/ccg-init-test' })
    const saved = mocks.writeConfig.mock.calls[0][0]
    expect(saved.performance.skillsMode).toBe('legacy')
    expect(saved.performance.skillsProfile).toBeUndefined()
  })

  it('returns a nonzero exit status and stops configuration side effects after installation fails', async () => {
    mocks.install.mockResolvedValueOnce({ success: false, installedCommands: [], installedPrompts: [], errors: ['Skill conflict'] })
    await init({ skipPrompt: true, installDir: '/tmp/ccg-init-test' })
    expect(process.exitCode).toBe(1)
    expect(mocks.spinnerFailed).toHaveBeenCalled()
    expect(mocks.spinnerSucceeded).not.toHaveBeenCalled()
    expect(mocks.installMcp).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skill conflict'))
  })

  it.each([[[]], [['verify-change', 'multi-agent']]])('preserves a native Skills selection %j during reinstall', async (skillsProfile) => {
    mocks.existing.performance.skillsProfile = skillsProfile
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(skillsProfile)
    expect(mocks.install.mock.calls[0][3].skillsProfile).toEqual(skillsProfile)
  })

  it.each([
    ['none', []],
    ['all', ['verify-change', 'multi-agent']],
    ['multi-agent,verify-change,multi-agent', ['multi-agent', 'verify-change']],
  ])('applies --skills %s without mutating the old profile', async (skills, expected) => {
    mocks.existing.performance.skillsProfile = ['verify-change']
    await init({ skipPrompt: true, skipMcp: true, skills, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(expected)
    expect(mocks.existing.performance.skillsProfile).toEqual(['verify-change'])
  })

  it.each(['', 'unknown-skill', 'all,multi-agent', 'none,all'])('rejects invalid --skills %s before writing configuration', async (skills) => {
    await expect(init({ skipPrompt: true, skipMcp: true, skills })).rejects.toThrow('Invalid Skills selection')
    expect(mocks.writeConfig).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('allows the user to clear the saved model to use the OpenCode default', async () => {
    mocks.prompt.mockResolvedValue({ selectedOpencodeModel: ' ' })
    expect(await promptOpencodeModel('deepseek/custom-test-model', false)).toBe('')
  })
})

describe('OpenCode model input', () => {
  it.each(['', ' ', 'deepseek/test-model', 'custom/model:latest', 'provider/org/model'])('accepts %j', (value) => {
    expect(validateOpencodeModel(value)).toBe(true)
  })
  it.each(['model-only', 'provider/model name', 'provider/model;touch', 'provider/$(id)', 'provider/`id`', 'provider/model\nnext'])('rejects %j', (value) => {
    expect(validateOpencodeModel(value)).not.toBe(true)
  })
})
