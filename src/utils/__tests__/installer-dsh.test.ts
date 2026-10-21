/**
 * Tests for installing dsh-ccg into a DeepSeek Harness profile.
 *
 * This installer rewrites a file the user owns and did not ask us to own — the
 * profile manifest that decides which plugins their harness loads. So what is
 * pinned here is mostly about restraint: touch both halves a plugin needs and
 * neither more, append rather than reorder, and never rewrite a manifest that
 * did not parse.
 *
 * The package-manager step is injected. What it does is `pnpm install`; what
 * matters is everything decided before it runs.
 */

import { homedir, tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import fs from 'fs-extra'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DSH_PLUGIN_NAME,
  defaultDshHome,
  dshPluginDir,
  findDshProfiles,
  hasDshHome,
  installDshPlugin,
  profileLinkCommand,
  uninstallDshPlugin,
} from '../installer-dsh'

let dshHome: string

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
}))

/** A linker that records its calls instead of spawning one. */
function recordingLinker(): { calls: string[], link: (dir: string, name: string) => undefined } {
  const calls: string[] = []
  return { calls, link: (_dir, name) => { calls.push(name); return undefined } }
}

/** Write a profile manifest under the temp harness home. */
async function makeProfile(name: string, pkg: Record<string, any>): Promise<string> {
  const dir = join(dshHome, 'profiles', name)
  await fs.ensureDir(dir)
  await fs.writeJson(join(dir, 'package.json'), pkg, { spaces: 2 })
  return dir
}

/** The shape a real profile has. */
const profileManifest = (bundles: string[] = ['@deepseek-ai/dsh-base']) => ({
  name: 'dsh-profile-test',
  private: true,
  dependencies: { 'some-other-plugin': '^1.0.0' },
  dsh: { profile: { bundles } },
})

beforeEach(async () => {
  vi.mocked(execFileSync).mockReset()
  dshHome = await mkdtemp(join(tmpdir(), 'ccg-dsh-'))
})

afterEach(async () => {
  await rm(dshHome, { recursive: true, force: true })
})

describe('findDshProfiles', () => {
  it('finds profiles and reports which already carry the plugin', async () => {
    await makeProfile('web', profileManifest(['@deepseek-ai/dsh-base', DSH_PLUGIN_NAME]))
    await makeProfile('headless', profileManifest())

    const found = await findDshProfiles(dshHome)
    expect(found.map(p => p.name)).toEqual(['headless', 'web'])
    expect(found.find(p => p.name === 'web')!.installed).toBe(true)
    expect(found.find(p => p.name === 'headless')!.installed).toBe(false)
  })

  it('skips the shared node_modules and anything without a bundles list', async () => {
    await makeProfile('web', profileManifest())
    // The profiles directory holds the shared dependency tree alongside the
    // profiles; it has a package.json and is not one.
    await fs.ensureDir(join(dshHome, 'profiles', 'node_modules'))
    await fs.writeJson(join(dshHome, 'profiles', 'node_modules', 'package.json'), { name: 'x' })
    await makeProfile('not-a-profile', { name: 'x', dependencies: {} })

    expect((await findDshProfiles(dshHome)).map(p => p.name)).toEqual(['web'])
  })

  it('ignores a manifest it cannot parse rather than risking a rewrite', async () => {
    await makeProfile('web', profileManifest())
    const broken = join(dshHome, 'profiles', 'broken')
    await fs.ensureDir(broken)
    await fs.writeFile(join(broken, 'package.json'), '{ not json')

    expect((await findDshProfiles(dshHome)).map(p => p.name)).toEqual(['web'])
  })

  it('answers for a machine with no harness at all', async () => {
    expect(await findDshProfiles(join(dshHome, 'nope'))).toEqual([])
    expect(await hasDshHome(join(dshHome, 'nope'))).toBe(false)
    await fs.ensureDir(join(dshHome, 'profiles'))
    expect(await hasDshHome(dshHome)).toBe(true)
  })
})

describe('profile package-manager invocation', () => {
  it('executes Unix programs with separate arguments', () => {
    expect(profileLinkCommand('dsh', ['plugin', '--profile', 'my profile', 'install'], 'darwin'))
      .toEqual({ file: 'dsh', args: ['plugin', '--profile', 'my profile', 'install'], windowsVerbatimArguments: false })
  })

  it('runs Windows cmd shims under a bare name with quoted arguments, and refuses shell expansion', () => {
    const command = profileLinkCommand('dsh', ['plugin', '--profile', '中文 profile', 'install'], 'win32')
    // A quoted shim name breaks `%~dp0` inside the shim; see profileLinkCommand.
    expect(command.args).toEqual(['/d', '/s', '/c', '"dsh "plugin" "--profile" "中文 profile" "install""'])
    expect(command.windowsVerbatimArguments).toBe(true)
    for (const name of ['a&echo secret', '%PATH%', 'a"b', 'a|b', '!TEMP!']) {
      expect(() => profileLinkCommand('dsh', ['plugin', '--profile', name, 'install'], 'win32')).toThrow(/metacharacters/)
    }
    for (const bin of ['"dsh"', 'my dsh', 'dsh&x']) {
      expect(() => profileLinkCommand(bin, ['install'], 'win32')).toThrow(/launcher name/)
    }
  })

  // Only cmd.exe can show the bug, so this runs on Windows alone.
  it.runIf(process.platform === 'win32')('lets a shim found through PATH see its own directory', async () => {
    const { execFileSync: run } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const shimDir = join(dshHome, 'shim')
    const cwd = join(dshHome, 'profiles', 'web')
    const out = join(dshHome, 'dp0.txt')
    await fs.ensureDir(shimDir)
    await fs.ensureDir(cwd)
    await fs.writeFile(join(shimDir, 'ccgshim.cmd'), '@echo %~dp0>"%CCG_DP0_OUT%"\r\n')

    const command = profileLinkCommand('ccgshim', ['install'])
    const options = {
      cwd,
      env: { ...process.env, PATH: `${shimDir.replace(/\//g, '\\')};${process.env.PATH}`, CCG_DP0_OUT: out },
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    }
    run(command.file, command.args, options)
    // Under the bug this is the profile directory, the cwd.
    const seen = (await fs.readFile(out, 'utf8')).trim().replace(/\\/g, '/').replace(/\/$/, '')
    expect(seen.toLowerCase().endsWith('/shim')).toBe(true)
  })
})

describe('installDshPlugin', () => {
  it('links the managed copy through the launcher in the target home', async () => {
    await makeProfile('web', profileManifest())
    const result = await installDshPlugin({ dshHome })
    expect(result.success).toBe(true)
    const command = profileLinkCommand('dsh', ['plugin', '--profile', 'web', 'install'])
    expect(execFileSync).toHaveBeenCalledWith(command.file, command.args, expect.objectContaining({
      env: expect.objectContaining({ DSH_HOME: dshHome }),
    }))
  })

  it('keeps a launcher compatibility refusal instead of bypassing it with pnpm', async () => {
    await makeProfile('web', profileManifest())
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('incompatible-version'), { status: 1, stderr: Buffer.from('incompatible-version') })
    })
    const result = await installDshPlugin({ dshHome })
    expect(result.success).toBe(false)
    expect(result.profiles).toEqual([])
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(result.warnings.join('\n')).toContain('incompatible-version')
  })

  it('falls back to pnpm when cmd.exe cannot find the launcher', async () => {
    await makeProfile('web', profileManifest())
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Command failed'), { status: 9009, stderr: Buffer.from('\'dsh\' is not recognized') })
    })
    const result = await installDshPlugin({ dshHome })
    expect(result.success).toBe(true)
    expect(execFileSync).toHaveBeenCalledTimes(2)
    const pnpm = profileLinkCommand('pnpm', ['install'])
    expect(execFileSync).toHaveBeenLastCalledWith(pnpm.file, pnpm.args, expect.anything())
  })

  it('writes both halves a profile needs, and copies the plugin somewhere stable', async () => {
    const dir = await makeProfile('web', profileManifest())
    const { calls, link } = recordingLinker()

    const result = await installDshPlugin({ dshHome, link })
    expect(result.success).toBe(true)
    expect(result.profiles).toEqual(['web'])
    expect(result.warnings).toEqual([])
    expect(calls).toEqual(['web'])

    const pkg = await fs.readJson(join(dir, 'package.json'))
    // A dependency alone does not load a plugin, and a bundle entry alone does
    // not resolve one. Both, or the profile silently does nothing.
    expect(pkg.dependencies[DSH_PLUGIN_NAME]).toBe(`link:${dshPluginDir(dshHome)}`)
    expect(pkg.dsh.profile.bundles).toContain(DSH_PLUGIN_NAME)

    // Pointing at PACKAGE_ROOT would break the moment npx evicts its cache, so
    // the plugin is copied to a path this installer owns.
    expect(await fs.pathExists(join(dshPluginDir(dshHome), 'src', 'index.js'))).toBe(true)
    expect(await fs.pathExists(join(dshPluginDir(dshHome), 'package.json'))).toBe(true)
    // The repo checkout carries tests and a node_modules symlink; a user's dsh
    // home has no use for either.
    expect(await fs.pathExists(join(dshPluginDir(dshHome), 'test'))).toBe(false)
    expect(await fs.pathExists(join(dshPluginDir(dshHome), 'node_modules'))).toBe(false)
  })

  it('leaves the rest of the manifest exactly as it found it', async () => {
    const dir = await makeProfile('web', profileManifest(['@deepseek-ai/dsh-base', 'their-plugin']))
    await installDshPlugin({ dshHome, link: recordingLinker().link })

    const pkg = await fs.readJson(join(dir, 'package.json'))
    expect(pkg.dependencies['some-other-plugin']).toBe('^1.0.0')
    // Appended, never inserted: bundle order is patch order, so moving an entry
    // would re-layer someone else's configuration.
    expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'their-plugin', DSH_PLUGIN_NAME])
  })

  it('is idempotent — installing twice adds one entry, not two', async () => {
    const dir = await makeProfile('web', profileManifest())
    await installDshPlugin({ dshHome, link: recordingLinker().link })
    await installDshPlugin({ dshHome, link: recordingLinker().link })

    const bundles: string[] = (await fs.readJson(join(dir, 'package.json'))).dsh.profile.bundles
    expect(bundles.filter(entry => entry === DSH_PLUGIN_NAME)).toHaveLength(1)
  })

  it('installs into only the named profiles', async () => {
    await makeProfile('web', profileManifest())
    const headless = await makeProfile('headless', profileManifest())

    const result = await installDshPlugin({ dshHome, profiles: ['headless'], link: recordingLinker().link })
    expect(result.profiles).toEqual(['headless'])
    expect((await fs.readJson(join(headless, 'package.json'))).dsh.profile.bundles).toContain(DSH_PLUGIN_NAME)

    const web = await fs.readJson(join(dshHome, 'profiles', 'web', 'package.json'))
    expect(web.dsh.profile.bundles).not.toContain(DSH_PLUGIN_NAME)
  })

  it('says what to do instead of failing silently when there is no profile', async () => {
    const result = await installDshPlugin({ dshHome, link: recordingLinker().link })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/dsh web/)
  })

  it('reports a failed link without claiming the staged plugin was installed', async () => {
    await makeProfile('web', profileManifest())
    const result = await installDshPlugin({ dshHome, link: () => 'ENOENT: pnpm not found' })

    expect(result.success).toBe(false)
    expect(result.profiles).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/linking failed/)
    expect(result.warnings.join('\n')).toMatch(/dsh plugin --profile web install/)
  })
})

describe('uninstallDshPlugin', () => {
  it('removes both halves and the copy, and leaves other plugins alone', async () => {
    const dir = await makeProfile('web', profileManifest(['@deepseek-ai/dsh-base', 'their-plugin']))
    await installDshPlugin({ dshHome, link: recordingLinker().link })
    expect(await fs.pathExists(dshPluginDir(dshHome))).toBe(true)

    const result = await uninstallDshPlugin({ dshHome, link: recordingLinker().link })
    expect(result.success).toBe(true)
    expect(result.profiles).toEqual(['web'])

    const pkg = await fs.readJson(join(dir, 'package.json'))
    expect(pkg.dependencies[DSH_PLUGIN_NAME]).toBeUndefined()
    expect(pkg.dependencies['some-other-plugin']).toBe('^1.0.0')
    expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'their-plugin'])
    expect(await fs.pathExists(dshPluginDir(dshHome))).toBe(false)
  })

  it('touches no manifest that never carried it', async () => {
    const dir = await makeProfile('web', profileManifest())
    const before = await fs.readFile(join(dir, 'package.json'), 'utf-8')

    const result = await uninstallDshPlugin({ dshHome, link: recordingLinker().link })
    expect(result.success).toBe(true)
    expect(result.profiles).toEqual([])
    expect(await fs.readFile(join(dir, 'package.json'), 'utf-8')).toBe(before)
  })
})

/**
 * Which home gets installed into when the caller names none.
 *
 * `DSH_HOME` is the harness's own way of being pointed somewhere else, and a
 * user who sets it has no `~/.dsh` for this to quietly fall back to: the
 * install would report success into a home nothing boots from, and the plugin
 * would simply never appear.
 */
describe('the harness home it defaults to', () => {
  const saved = process.env.DSH_HOME

  afterEach(() => {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  })

  it('follows DSH_HOME when the harness has been pointed elsewhere', () => {
    process.env.DSH_HOME = join(tmpdir(), 'somewhere-else')
    expect(defaultDshHome()).toBe(join(tmpdir(), 'somewhere-else'))
    expect(dshPluginDir()).toBe(join(tmpdir(), 'somewhere-else', 'ccg', DSH_PLUGIN_NAME))
  })

  it('falls back to ~/.dsh when it is unset or blank', () => {
    delete process.env.DSH_HOME
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))

    // An exported-but-empty variable is not a home; treating it as one would
    // resolve the plugin directory against the filesystem root.
    process.env.DSH_HOME = '   '
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })
})
