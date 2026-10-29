import type { CAC } from 'cac'
import type { CliOptions } from './types'
import ansis from 'ansis'
import { version } from '../package.json'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { configMcp } from './commands/config-mcp'
import { doctor, status } from './commands/doctor'
import { diagnoseMcp, fixMcp } from './commands/diagnose-mcp'
import { init } from './commands/init'
import { ledger } from './commands/ledger'
import { update } from './commands/update'
import { showMainMenu } from './commands/menu'
import { registerSkillCommands } from './commands/skills'
import { i18n, initI18n } from './i18n'
import { readCcgConfig } from './utils/config'
import { installCodexMode, uninstallCodexMode, uninstallWorkflows } from './utils/installer'

/** cac coerces numeric-looking values (an all-digit event id, `--text 007`); read string options from argv as typed. */
function rawOption(name: string, parsed: unknown): string | undefined {
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1]
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3)
  }
  return parsed == null ? undefined : String(parsed)
}

function customizeHelp(sections: any[]): any[] {
  sections.unshift({
    title: '',
    body: ansis.cyan.bold(`CCG - Claude + Codex + Gemini v${version}`),
  })

  sections.push({
    title: ansis.yellow(i18n.t('cli:help.commands')),
    body: [
      `  ${ansis.cyan('ccg')}              ${i18n.t('cli:help.commandDescriptions.showMenu')}`,
      `  ${ansis.cyan('ccg init')} | ${ansis.cyan('i')}     ${i18n.t('cli:help.commandDescriptions.initConfig')}`,
      `  ${ansis.cyan('ccg config mcp')}   ${i18n.t('cli:help.commandDescriptions.configMcp')}`,
      `  ${ansis.cyan('ccg diagnose-mcp')} ${i18n.t('cli:help.commandDescriptions.diagnoseMcp')}`,
      `  ${ansis.cyan('ccg fix-mcp')}      ${i18n.t('cli:help.commandDescriptions.fixMcp')}`,
      `  ${ansis.cyan('ccg doctor')}       Check installation health`,
      `  ${ansis.cyan('ccg status')}       Show installation overview`,
      `  ${ansis.cyan('ccg codex-mode')}   Install/uninstall Codex-Led mode`,
      `  ${ansis.cyan('ccg ledger')}       Decision ledger (status, on/off, run-id, append)`,
      `  ${ansis.cyan('ccg uninstall')}    Uninstall CCG (non-interactive)`,
      '',
      ansis.gray(`  ${i18n.t('cli:help.shortcuts')}`),
      `  ${ansis.cyan('ccg i')}            ${i18n.t('cli:help.shortcutDescriptions.quickInit')}`,
    ].join('\n'),
  })

  sections.push({
    title: ansis.yellow(i18n.t('cli:help.options')),
    body: [
      `  ${ansis.green('--lang, -l')} <lang>         ${i18n.t('cli:help.optionDescriptions.displayLanguage')} (zh-CN, en)`,
      `  ${ansis.green('--force, -f')}               ${i18n.t('cli:help.optionDescriptions.forceOverwrite')}`,
      `  ${ansis.green('--help, -h')}                ${i18n.t('cli:help.optionDescriptions.displayHelp')}`,
      `  ${ansis.green('--version, -v')}             ${i18n.t('cli:help.optionDescriptions.displayVersion')}`,
      '',
      ansis.gray(`  ${i18n.t('cli:help.nonInteractiveMode')}`),
      `  ${ansis.green('--skip-prompt, -s')}         ${i18n.t('cli:help.optionDescriptions.skipAllPrompts')}`,
      `  ${ansis.green('--frontend, -F')} <models>   ${i18n.t('cli:help.optionDescriptions.frontendModels')}`,
      `  ${ansis.green('--backend, -B')} <models>    ${i18n.t('cli:help.optionDescriptions.backendModels')}`,
      `  ${ansis.green('--mode, -m')} <mode>         ${i18n.t('cli:help.optionDescriptions.collaborationMode')}`,
      `  ${ansis.green('--workflows, -w')} <list>    ${i18n.t('cli:help.optionDescriptions.workflows')}`,
      `  ${ansis.green('--install-dir, -d')} <path>  ${i18n.t('cli:help.optionDescriptions.installDir')}`,
    ].join('\n'),
  })

  sections.push({
    title: ansis.yellow(i18n.t('cli:help.examples')),
    body: [
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.showInteractiveMenu')}`),
      `  ${ansis.cyan('npx ccg')}`,
      '',
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.runFullInitialization')}`),
      `  ${ansis.cyan('npx ccg init')}`,
      `  ${ansis.cyan('npx ccg i')}`,
      '',
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.customModels')}`),
      `  ${ansis.cyan('npx ccg i --frontend gemini,codex --backend codex,gemini')}`,
      '',
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.parallelMode')}`),
      `  ${ansis.cyan('npx ccg i --mode parallel')}`,
      '',
    ].join('\n'),
  })

  return sections
}

export async function setupCommands(cli: CAC): Promise<void> {
  try {
    const config = await readCcgConfig()
    const defaultLang = config?.general?.language || 'zh-CN'
    await initI18n(defaultLang)
  }
  catch {
    await initI18n('zh-CN')
  }

  registerSkillCommands(cli)

  // Default command - show menu
  cli
    .command('', i18n.t('cli:help.commandDescriptions.showMenu'))
    .option('--lang, -l <lang>', `${i18n.t('cli:help.optionDescriptions.displayLanguage')} (zh-CN, en)`)
    .action(async (options: CliOptions) => {
      if (options.lang) {
        await initI18n(options.lang)
      }
      await showMainMenu()
    })

  // Init command
  cli
    .command('init', i18n.t('cli:help.commandDescriptions.initConfig'))
    .alias('i')
    .option('--lang, -l <lang>', `${i18n.t('cli:help.optionDescriptions.displayLanguage')} (zh-CN, en)`)
    .option('--force, -f', i18n.t('cli:help.optionDescriptions.forceOverwrite'))
    .option('--skip-prompt, -s', i18n.t('cli:help.optionDescriptions.skipAllPrompts'))
    .option('--skip-mcp', 'Skip MCP configuration (used during update)')
    .option('--frontend, -F <models>', i18n.t('cli:help.optionDescriptions.frontendModels'))
    .option('--backend, -B <models>', i18n.t('cli:help.optionDescriptions.backendModels'))
    .option('--mode, -m <mode>', i18n.t('cli:help.optionDescriptions.collaborationMode'))
    .option('--workflows, -w <workflows>', i18n.t('cli:help.optionDescriptions.workflows'))
    .option('--skills <names>', 'Native skills: comma-separated names, all, or none')
    .option('--install-dir, -d <path>', i18n.t('cli:help.optionDescriptions.installDir'))
    .action(async (options: CliOptions) => {
      if (options.lang) {
        await initI18n(options.lang)
      }
      await init(options)
    })

  // Diagnose MCP command
  cli
    .command('diagnose-mcp', i18n.t('cli:help.commandDescriptions.diagnoseMcp'))
    .action(async () => {
      await diagnoseMcp()
    })

  // Fix MCP command (Windows only)
  cli
    .command('fix-mcp', i18n.t('cli:help.commandDescriptions.fixMcp'))
    .action(async () => {
      await fixMcp()
    })

  // Config MCP command
  cli
    .command('config <subcommand>', i18n.t('cli:help.commandDescriptions.configMcp'))
    .action(async (subcommand: string) => {
      if (subcommand === 'mcp') {
        await configMcp()
      }
      else {
        console.log(ansis.red(i18n.t('common:unknownSubcommand', { subcommand })))
        console.log(ansis.gray(i18n.t('common:availableSubcommands', { list: 'mcp' })))
      }
    })

  cli.command('update', 'Show the OpenSlime checkout update command')
    .action(async () => { await update() })

  // Doctor: environment health check
  cli
    .command('doctor', 'Check CCG installation health')
    .option('--json', 'Print machine-readable diagnostic report')
    .action(async (options) => { await doctor(options) })

  // Status: show current installation overview
  cli
    .command('status', 'Show CCG installation status')
    .action(async () => { await status() })

  // Ledger: decisions, outcomes and lessons recorded at stage boundaries
  cli
    .command('ledger [...args]', 'Decision ledger: status, on/off, run-id, append, summary, harness, lessons')
    .option('--json', 'Print JSON')
    .option('--project-root <path>', 'Project to record for (default: cwd)')
    .option('--project <id>', 'Summarize this project id')
    .option('--all-projects', 'Summarize every project')
    .option('--by-harness', 'Compare harness versions')
    .option('--params', 'Print the built-in parameter set')
    .option('--limit <n>', 'Max output lines')
    .option('--max-bytes <n>', 'Max output bytes')
    .option('--files <globs>', 'lessons query: changed files, comma-separated')
    .option('--kind <kind>', 'lessons query: backend|frontend|any')
    .option('--text <text>', 'lessons query: task description')
    .option('--scope <scope>', 'lessons: project|global|both')
    .option('--all', 'lessons query: include candidate and retired')
    .option('--decision <event>', 'lessons adopt/promote: the recorded decision event id')
    .option('--confirm', 'lessons adopt/promote: confirm the change')
    .option('--reason <text>', 'lessons retire: why')
    .option('--run-id <id>', 'lessons: run id for the state events')
    .option('--change <id>', 'probes: change id')
    .option('--lesson <id>', 'probes: lesson id')
    .allowUnknownOptions()
    .action(async (args: string[], options) => {
      const code = await ledger(args.map(String), {
        json: options.json,
        projectRoot: rawOption('project-root', options.projectRoot),
        project: rawOption('project', options.project),
        allProjects: options.allProjects,
        byHarness: options.byHarness,
        params: options.params,
        limit: options.limit,
        maxBytes: options.maxBytes,
        files: rawOption('files', options.files),
        kind: rawOption('kind', options.kind),
        text: rawOption('text', options.text),
        scope: rawOption('scope', options.scope),
        all: options.all,
        decision: rawOption('decision', options.decision),
        confirm: options.confirm,
        reason: rawOption('reason', options.reason),
        runId: rawOption('run-id', options.runId),
        change: rawOption('change', options.change),
        lesson: rawOption('lesson', options.lesson),
      })
      if (process.exitCode !== 130) process.exitCode = code
    })

  // Codex mode: non-interactive install/uninstall
  cli
    .command('codex-mode <action>', 'Install or uninstall Codex-Led mode (non-interactive)')
    .action(async (action: string) => {
      if (action === 'install') {
        const result = await installCodexMode()
        if (result.success) {
          console.log(ansis.green('✓ Codex mode installed'))
          console.log(result.message)
        }
        else {
          console.error(ansis.red(`✗ ${result.message}`))
          process.exitCode = 1
        }
      }
      else if (action === 'uninstall') {
        const result = await uninstallCodexMode()
        if (result.success) {
          console.log(ansis.green('✓ Codex mode uninstalled'))
          if (result.removed.length > 0) console.log(ansis.gray(`  Removed: ${result.removed.join(', ')}`))
        }
        else {
          console.error(ansis.red('✗ Codex mode uninstall failed'))
          process.exitCode = 1
        }
      }
      else {
        console.error(ansis.red(`Unknown action: ${action}`))
        console.log(ansis.gray('Usage: ccg codex-mode <install|uninstall>'))
        process.exitCode = 1
      }
    })

  // Uninstall CCG (Claude Code mode): non-interactive
  cli
    .command('uninstall', 'Uninstall CCG workflows from ~/.claude/ (non-interactive)')
    .action(async () => {
      const installDir = join(homedir(), '.claude')
      const result = await uninstallWorkflows(installDir)
      if (result.success) {
        console.log(ansis.green('✓ CCG uninstalled'))
        if (result.removedCommands.length > 0) console.log(ansis.gray(`  Commands: ${result.removedCommands.length} removed`))
        if (result.removedHooks) console.log(ansis.gray('  Hooks: removed'))
        if (result.removedBin) console.log(ansis.gray('  Binary: removed'))
        if (result.removedShim) console.log(ansis.gray('  osm ledger shim: removed'))
        if (result.ledgerPreserved) console.log(ansis.gray(`  Decision ledger kept: ${result.ledgerPreserved}`))
      }
      else {
        console.error(ansis.red('✗ Uninstall failed'))
        for (const err of result.errors) console.error(ansis.gray(`  ${err}`))
        process.exitCode = 1
      }
    })

  cli.help(sections => customizeHelp(sections))
  cli.version(version)
}
