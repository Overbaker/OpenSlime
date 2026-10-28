import type { CAC } from 'cac'
import inquirer from 'inquirer'
import { getSkillCatalog, installedNames, installSkills, listSkills, removeSkills, syncSkills, updateSkills } from '../utils/skill-manager'
import type { SkillManagerOptions, SkillTarget } from '../utils/skill-manager'
import { resolveSkillPaths } from '../utils/skill-manager'
import { readCcgConfig, writeCcgConfig } from '../utils/config'

export interface SkillCommandOptions extends SkillManagerOptions { json?: boolean, installed?: boolean }

async function saveNativeSelection(selected: string[], options: SkillManagerOptions): Promise<void> {
  const paths = resolveSkillPaths(options)
  const defaults = resolveSkillPaths({ target: 'claude' })
  if (paths.target !== 'claude' || paths.nativeDir !== defaults.nativeDir || paths.storeDir !== defaults.storeDir) return
  const config = await readCcgConfig()
  if (!config) return
  config.performance = { ...config.performance, skillsProfile: selected, skillsMode: 'native' }
  await writeCcgConfig(config)
}

export async function runSkillsCommand(action = 'list', names: string[] = [], options: SkillCommandOptions = {}): Promise<void> {
  if (!['catalog', 'list', 'install', 'update', 'remove'].includes(action)) throw new Error(`Unknown skills action: ${action}`)
  if (['catalog', 'list', 'update'].includes(action) && names.length) throw new Error(`${action} does not accept skill names`)
  if (['install', 'remove'].includes(action) && !names.length) throw new Error(`${action} requires one or more catalog slugs`)
  if (action === 'catalog') {
    const catalog = getSkillCatalog(options).map(({ name, description, category }) => ({ name, alias: `ccg-${name}`, description, category }))
    if (options.json) console.log(JSON.stringify(catalog, null, 2))
    else for (const entry of catalog) console.log(`${entry.name} [${entry.category}] ${entry.description}`)
    return
  }
  if (action === 'list') {
    let entries = await listSkills(options)
    if (options.installed) entries = entries.filter(s => s.installed)
    if (options.json) console.log(JSON.stringify(entries, null, 2))
    else {
      console.log(`Skills (${options.target ?? 'claude'}): ${entries.filter(s => s.installed).length} selected`)
      for (const entry of entries) console.log(`${entry.installed ? (entry.healthy ? '✓' : '!') : '·'} ${entry.name} [${entry.category}] ${entry.description}`)
    }
    return
  }
  const selected = action === 'install' ? await installSkills(names, options)
    : action === 'remove' ? await removeSkills(names, options) : await updateSkills(options)
  const result = { action, target: options.target ?? 'claude', selected, count: selected.length }
  await saveNativeSelection(selected, options)
  console.log(options.json ? JSON.stringify(result, null, 2) : `Skills (${result.target}): ${result.count} selected — ${selected.join(', ') || '(none)'}`)
}

export function registerSkillCommands(cli: CAC): void {
  cli.command('skills [action] [...names]', 'List, install, update or remove selected native CCG skills')
    .option('--target <target>', 'Native host: claude or codex', { default: 'claude' })
    .option('--json', 'Print machine-readable JSON')
    .option('--installed', 'Show only managed selections with list')
    .action(runSkillsCommand)
}

/** Changes only native entries recorded by this manager; legacy CCG skills remain intact. */
export async function manageSkillsMenu(options: SkillManagerOptions = {}): Promise<void> {
  const answer = await inquirer.prompt<{ target: SkillTarget }>([{
    type: 'list', name: 'target', message: '选择 Skills 使用端', default: options.target ?? 'claude',
    choices: [{ name: 'Claude Code', value: 'claude' }, { name: 'Codex', value: 'codex' }],
  }])
  const paths = { ...options, target: answer.target }
  const catalog = getSkillCatalog(paths)
  const current = await installedNames(paths)
  const { names } = await inquirer.prompt<{ names: string[] }>([{
    type: 'checkbox', name: 'names', message: `选择要启用的 Skills（当前 ${current.length} 个；空选关闭本工具受管入口）`,
    pageSize: 15,
    choices: catalog.map(s => ({ name: `${s.name} [${s.category}] — ${s.description}`, value: s.name, checked: current.includes(s.name) })),
  }])
  const selected = await syncSkills({ ...paths, names })
  await saveNativeSelection(selected, paths)
  console.log(`Skills (${answer.target}): 已启用 ${selected.length} 个 — ${selected.join(', ') || '(无)'}`)
}
