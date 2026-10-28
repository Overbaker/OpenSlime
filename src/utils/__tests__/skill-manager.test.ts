import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSkillCatalog, installedNames, installSkills, listSkills, removeSkills, resolveSkillPaths, syncSkills, updateSkills } from '../skill-manager'
import type { SkillManagerOptions } from '../skill-manager'

let root: string
let options: SkillManagerOptions
const skill = (name: string, body = '') => `---\nname: ${name}\ndescription: ${name} test skill\n---\n${body}\n`
async function write(rel: string, data: string) {
  const path = join(options.templatesDir!, rel)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
}
async function manifest() { return JSON.parse(await fs.readFile(join(options.storeDir!, 'manifest.json'), 'utf8')) }
async function nativeSkillNames(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const name of await fs.readdir(dir)) {
    const path = join(dir, name)
    if ((await fs.stat(path)).isDirectory()) found.push(...await nativeSkillNames(path))
    else if (name === 'SKILL.md') found.push((await fs.readFile(path, 'utf8')).match(/^name: (.+)$/m)![1])
  }
  return found.sort()
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ccg-skills-test-'))
  // Canonicalize macOS /var alias so assertions match the manifest's pinned paths.
  root = await fs.realpath(root)
  options = { templatesDir: join(root, 'templates'), nativeDir: join(root, 'native'), storeDir: join(root, 'store'), version: 'fixture-1' }
  await write('SKILL.md', skill('aggregate'))
  await write('tools/quality/SKILL.md', skill('quality', 'node scripts/check.js ./src\n~/.claude/skills/ccg/run_skill.js'))
  await write('tools/quality/scripts/check.js', 'console.log(require("../../lib/shared.js"))\n')
  await write('tools/lib/shared.js', 'module.exports="dependency-ok"\n')
  await write('run_skill.js', 'console.log("runner")\n')
  await write('design/SKILL.md', skill('design', 'refs/example.md'))
  await write('design/refs/example.md', 'reference preserved')
  await write('domains/security/SKILL.md', skill('security'))
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

describe('native skill catalog and installation', () => {
  it('excludes aggregate and security and includes multi-script skills', async () => {
    await write('tools/quality/scripts/extra.js', '// another helper')
    expect(getSkillCatalog(options).map(s => s.name)).toEqual(['design', 'quality'])
  })
  it('rejects duplicate catalog slugs instead of silently hiding them', async () => {
    await write('duplicate/SKILL.md', skill('quality'))
    expect(() => getSkillCatalog(options)).toThrow('Duplicate')
  })
  it.each(['claude', 'codex'] as const)('installs only selected native aliases with script/ref dependencies for %s', async (target) => {
    options.target = target
    await installSkills(['quality'], options)
    expect(await fs.readdir(options.nativeDir!)).toEqual(['ccg-quality'])
    const link = join(options.nativeDir!, 'ccg-quality')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(join(link, 'SKILL.md'), 'utf8')).toContain('name: ccg-quality')
    const record = (await manifest()).skills[0]
    const tree = join(options.storeDir!, 'snapshots', record.snapshot, 'tree')
    expect(execFileSync(process.execPath, [join(tree, 'tools/quality/scripts/check.js')], { encoding: 'utf8' })).toContain('dependency-ok')
    expect(await fs.readFile(join(tree, 'run_skill.js'), 'utf8')).toContain('runner')
    expect(await fs.readFile(join(link, 'SKILL.md'), 'utf8')).toContain(join(tree, 'tools/quality'))
    expect((await listSkills(options)).find(s => s.installed)?.healthy).toBe(true)
    expect(await installedNames(options)).toEqual(['quality'])
  })
  it('preserves legacy and external skills and never claims them', async () => {
    await fs.mkdir(join(options.nativeDir!, 'ccg'), { recursive: true })
    await fs.writeFile(join(options.nativeDir!, 'ccg', 'user.md'), 'legacy')
    await fs.mkdir(join(options.nativeDir!, 'external'))
    await syncSkills({ ...options, names: ['quality', 'design'] })
    await syncSkills({ ...options, names: ['design'] })
    expect(await fs.readdir(options.nativeDir!)).toEqual(['ccg', 'ccg-design', 'external'])
    const record = (await manifest()).skills[0]
    expect(await fs.readFile(join(options.storeDir!, 'snapshots', record.snapshot, 'tree/design/refs/example.md'), 'utf8')).toBe('reference preserved')
  })
  it('rewrites skill invocations but preserves URLs and absolute file paths', async () => {
    await write('design/SKILL.md', skill('design', 'Invoke `/quality`. Link https://example.com/quality\nFile /tmp/quality\n'))
    await installSkills(['design'], options)
    const text = await fs.readFile(join(options.nativeDir!, 'ccg-design/SKILL.md'), 'utf8')
    expect(text).toContain('`/ccg-quality`')
    expect(text).toContain('https://example.com/quality')
    expect(text).toContain('/tmp/quality')
  })
  it.each([['../escape'], ['unknown'], ['quality', 'quality']])('rejects invalid selections %j', async (...args) => {
    const names = args as string[]
    await expect(installSkills(names, options)).rejects.toThrow()
    expect(await fs.readdir(options.nativeDir!).catch(() => [])).toEqual([])
  })
  it('refuses an unmanaged directory or dangling symlink in its namespace', async () => {
    await fs.mkdir(options.nativeDir!, { recursive: true })
    await fs.symlink(join(root, 'missing'), join(options.nativeDir!, 'ccg-quality'))
    await expect(installSkills(['quality'], options)).rejects.toThrow('Unmanaged')
    expect(await fs.readlink(join(options.nativeDir!, 'ccg-quality'))).toBe(join(root, 'missing'))
  })
})

describe('ownership, update and atomic boundaries', () => {
  it('updates only managed selections to a new immutable snapshot and retains old cache', async () => {
    await installSkills(['quality'], options)
    const old = (await manifest()).skills[0]
    await write('tools/lib/shared.js', 'module.exports="new-dependency"\n')
    await updateSkills({ ...options, version: 'fixture-2' })
    const next = (await manifest()).skills[0]
    expect(next.snapshot).not.toBe(old.snapshot)
    expect(await fs.readFile(join(options.storeDir!, 'snapshots', old.snapshot, 'tree/tools/lib/shared.js'), 'utf8')).toContain('dependency-ok')
    expect(await installedNames(options)).toEqual(['quality'])
    expect((await listSkills(options)).find(s => s.installed)?.version).toBe('fixture-2')
  })
  it('refuses modified cache update but removes its owned alias while retaining edited cache', async () => {
    await installSkills(['quality'], options)
    const old = (await manifest()).skills[0]
    await fs.writeFile(join(old.target, 'SKILL.md'), 'user edit')
    expect((await listSkills(options)).find(s => s.installed)?.healthy).toBe(false)
    await expect(updateSkills(options)).rejects.toThrow('Modified')
    await removeSkills(['quality'], options)
    expect(await fs.readdir(options.nativeDir!)).toEqual([])
    expect(await fs.readFile(join(old.target, 'SKILL.md'), 'utf8')).toBe('user edit')
  })
  it('refuses externally replaced aliases even when manifest claims ownership', async () => {
    await installSkills(['quality'], options)
    const path = join(options.nativeDir!, 'ccg-quality')
    await fs.unlink(path)
    await fs.mkdir(path)
    await expect(removeSkills(['quality'], options)).rejects.toThrow('changed')
    expect((await fs.lstat(path)).isDirectory()).toBe(true)
  })
  it('refuses corrupted or escaping ownership manifests', async () => {
    await installSkills(['quality'], options)
    const value = await manifest()
    value.skills[0].target = root
    await fs.writeFile(join(options.storeDir!, 'manifest.json'), JSON.stringify(value))
    await expect(removeSkills(['quality'], options)).rejects.toThrow('escapes')
    await fs.writeFile(join(options.storeDir!, 'manifest.json'), '{ broken')
    await expect(updateSkills(options)).rejects.toThrow()
    expect(await fs.readdir(options.nativeDir!)).toEqual(['ccg-quality'])
  })
  it('refuses a manifest pointing to another skill directory inside a snapshot', async () => {
    await installSkills(['quality'], options)
    const value = await manifest()
    value.skills[0].target = join(options.storeDir!, 'snapshots', value.skills[0].snapshot, 'tree', 'design')
    await fs.writeFile(join(options.storeDir!, 'manifest.json'), JSON.stringify(value))
    await expect(removeSkills(['quality'], options)).rejects.toThrow('entry target')
    expect(await fs.readdir(options.nativeDir!)).toEqual(['ccg-quality'])
  })
  it('rejects concurrent mutation and leaves complete JSON without temp files', async () => {
    const results = await Promise.allSettled([installSkills(['quality'], options), installSkills(['design'], options)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect((await manifest()).skills).toHaveLength(1)
    expect((await fs.readdir(options.storeDir!)).filter(n => n.endsWith('.tmp') || n.endsWith('.lock'))).toEqual([])
  })
  it('rolls links back if atomic manifest replacement fails', async () => {
    await installSkills(['quality'], options)
    const original = await fs.readlink(join(options.nativeDir!, 'ccg-quality'))
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('manifest.json')) throw new Error('disk full')
      return rename(from, to)
    })
    await expect(syncSkills({ ...options, names: ['design'] })).rejects.toThrow('disk full')
    expect(await fs.readdir(options.nativeDir!)).toEqual(['ccg-quality'])
    expect(await fs.readlink(join(options.nativeDir!, 'ccg-quality'))).toBe(original)
    expect(await installedNames(options)).toEqual(['quality'])
  })
  it('rejects source symlinks, managed root aliases and overlapping storage paths', async () => {
    await fs.symlink(root, join(options.templatesDir!, 'foreign'))
    await expect(installSkills(['quality'], options)).rejects.toThrow('symlink')
    await fs.unlink(join(options.templatesDir!, 'foreign'))
    await fs.mkdir(join(root, 'outside'))
    await fs.symlink(join(root, 'outside'), join(root, 'store-link'))
    await expect(installSkills(['quality'], { ...options, storeDir: join(root, 'store-link') })).rejects.toThrow('plain directory')
    await expect(installSkills(['quality'], { ...options, storeDir: join(options.nativeDir!, 'cache') })).rejects.toThrow('separate')
    expect(() => resolveSkillPaths({ nativeDir: '../bad' })).toThrow('Absolute')
  })
  it('does not remove unknown or unmanaged names', async () => {
    await installSkills(['quality'], options)
    await expect(removeSkills(['design'], options)).rejects.toThrow('Only managed')
    expect(await installedNames(options)).toEqual(['quality'])
  })
  it('does not expose unselected nested skills through a selected parent', async () => {
    await write('design/nested/SKILL.md', skill('nested-design'))
    await installSkills(['design'], options)
    expect(await fs.readdir(join(options.nativeDir!, 'ccg-design'))).toEqual(['SKILL.md'])
    expect(await fs.readdir(options.nativeDir!)).toEqual(['ccg-design'])
    const record = (await manifest()).skills[0]
    expect(await fs.readFile(join(options.storeDir!, 'snapshots', record.snapshot, 'tree/design/nested/SKILL.md'), 'utf8')).toContain('name: nested-design')
    expect(await nativeSkillNames(options.nativeDir!)).toEqual(['ccg-design'])
  })
  it('binds explicit resource macros in the facade while keeping cached source unchanged', async () => {
    const body = 'node "${CLAUDE_SKILL_DIR}/scripts/check.js"\n${CODEX_SKILL_DIR}/refs\n${SKILL_DIR}/file'
    await write('tools/quality/SKILL.md', skill('quality', body))
    await installSkills(['quality'], options)
    const record = (await manifest()).skills[0]
    const base = join(options.storeDir!, 'snapshots', record.snapshot, 'tree/tools/quality')
    const facade = await fs.readFile(join(record.target, 'SKILL.md'), 'utf8')
    expect(facade).toContain(`node "${base}/scripts/check.js"`)
    expect(execFileSync(process.execPath, [join(base, 'scripts/check.js')], { encoding: 'utf8' })).toContain('dependency-ok')
    expect(await fs.readFile(join(base, 'SKILL.md'), 'utf8')).toContain(body)
  })
  it('preserves a source package declaration when the source supplies its own module boundary', async () => {
    await write('package.json', '{"type":"commonjs","name":"upstream-skill-assets"}\n')
    await installSkills(['quality'], options)
    const record = (await manifest()).skills[0]
    const path = join(options.storeDir!, 'snapshots', record.snapshot, 'tree/package.json')
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ type: 'commonjs', name: 'upstream-skill-assets' })
    expect((await listSkills(options)).find(s => s.installed)?.healthy).toBe(true)
  })
  it('permits removal of a retired skill without pretending it is in the current catalog', async () => {
    await installSkills(['quality'], options)
    await fs.rm(join(options.templatesDir!, 'tools/quality'), { recursive: true })
    expect((await listSkills(options)).find(s => s.name === 'quality')).toMatchObject({ installed: true, category: 'retired' })
    await expect(updateSkills(options)).rejects.toThrow('Unknown skill')
    await removeSkills(['quality'], options)
    expect(await installedNames(options)).toEqual([])
  })
})
