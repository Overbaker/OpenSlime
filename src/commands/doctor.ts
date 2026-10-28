import type { DoctorDependencies, DoctorReport } from '../utils/doctor-checks'
import ansis from 'ansis'
import fs from 'fs-extra'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { readCcgConfig } from '../utils/config'
import { collectDoctorReport } from '../utils/doctor-checks'
import { version as packageVersion } from '../../package.json'

const OK = ansis.green('✓')
const WARN = ansis.yellow('⚠')
const FAIL = ansis.red('✗')

async function fileExists(p: string): Promise<boolean> {
  return fs.pathExists(p)
}

async function dirFiles(p: string): Promise<string[]> {
  if (!(await fs.pathExists(p))) return []
  return (await fs.readdir(p)).filter(f => !f.startsWith('.'))
}

// `execSync` is imported at the top, not required here. `dist/cli.mjs` is an ES
// module built without a `createRequire` shim, so a `require()` in this scope
// throws ReferenceError — and this catch would swallow it and answer `null`,
// which every caller reads as "not installed". A working binary reported as
// missing (#161), on every platform, with reinstalling unable to help.
function execSafe(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: 'pipe', timeout: 10000 }).toString().trim()
  }
  catch { return null }
}

export async function doctor(options: { json?: boolean } = {}, deps: DoctorDependencies = {}): Promise<DoctorReport> {
  const report = await collectDoctorReport(deps)
  const output = deps.output || console.log
  if (options.json) {
    output(JSON.stringify(report, null, 2))
  }
  else {
    output(`\n  ${ansis.cyan.bold(`CCG Doctor v${packageVersion}`)}\n`)
    const icons = { pass: OK, warn: WARN, fail: FAIL, skip: ansis.gray('—') }
    for (const { label, status, detail, remediation } of report.checks) {
      output(`  ${icons[status]} ${ansis.bold(label.padEnd(20))} ${ansis.gray(detail)}`)
      if (remediation && (status === 'fail' || status === 'warn')) output(`    ${ansis.yellow(remediation)}`)
    }
    output(report.failureCount === 0
      ? `\n  ${report.warningCount ? ansis.yellow(`No failures; ${report.warningCount} warning(s).`) : ansis.green('All checks passed.')}\n`
      : `\n  ${ansis.red(`${report.failureCount} issue(s) found. Run npx ccg-workflow to repair.`)}\n`)
  }
  const setExitCode = deps.setExitCode || ((code: number) => { process.exitCode = code })
  setExitCode(report.failureCount > 0 ? 1 : 0)
  return report
}

export async function status(): Promise<void> {
  const installDir = join(homedir(), '.claude')

  // Version
  const config = await readCcgConfig()
  const installedVer = config?.general?.version || 'unknown'
  const latestVer = execSafe('npm view ccg-workflow version') || 'unknown'

  // Commands
  const cmds = (await dirFiles(join(installDir, 'commands', 'osm'))).filter(f => f.endsWith('.md'))

  // Hooks
  const hooks = (await dirFiles(join(installDir, 'hooks', 'ccg'))).filter(f => f.endsWith('.js'))

  // Binary
  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const wrapperPath = join(installDir, 'bin', wrapperName)
  let binaryVer = '—'
  if (await fileExists(wrapperPath)) {
    const raw = execSafe(`"${wrapperPath}" --version`)
    if (raw) binaryVer = raw.replace(/^.*version\s*/, 'v')
  }

  // Model routing
  const frontend = config?.routing?.frontend?.primary || '—'
  const backend = config?.routing?.backend?.primary || '—'

  // MCP
  let mcpServers: string[] = []
  const claudeJsonPath = join(homedir(), '.claude.json')
  if (await fileExists(claudeJsonPath)) {
    try {
      const cj = await fs.readJSON(claudeJsonPath)
      mcpServers = Object.keys(cj.mcpServers || {})
    }
    catch { /* ignore */ }
  }

  // Active tasks
  let activeTasks = 0
  const tasksDir = join(process.cwd(), '.ccg', 'tasks')
  if (await fileExists(tasksDir)) {
    for (const d of await fs.readdir(tasksDir)) {
      if (d === 'archive') continue
      const taskJson = join(tasksDir, d, 'task.json')
      if (await fileExists(taskJson)) {
        try {
          const t = await fs.readJSON(taskJson)
          const s = String(t.status || '').toLowerCase()
          if (!['completed', 'complete', 'done', 'finished', 'archived', 'cancelled', 'closed'].includes(s)) {
            activeTasks++
          }
        }
        catch { /* ignore */ }
      }
    }
  }

  // Codex mode
  let codexMode = false
  try {
    const agentsPath = join(homedir(), '.codex', 'AGENTS.md')
    const markerPath = join(homedir(), '.codex', '.ccg-version')
    const agents = await fileExists(agentsPath) ? await fs.readFile(agentsPath, 'utf8') : ''
    const marker = await fileExists(markerPath) ? await fs.readFile(markerPath, 'utf8') : ''
    codexMode = agents.includes('<!-- CCG:START') || /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(marker.trim())
  }
  catch { /* Unreadable files do not prove a CCG installation. */ }

  // Output
  console.log()
  console.log(ansis.cyan.bold('  CCG Status'))
  console.log()
  console.log(`  ${ansis.bold('Version')}        ${installedVer}${installedVer !== latestVer ? ansis.yellow(` (latest: ${latestVer})`) : ansis.green(' (up to date)')}`)
  console.log(`  ${ansis.bold('Commands')}       ${cmds.length}`)
  console.log(`  ${ansis.bold('Hooks')}          ${hooks.length} scripts`)
  console.log(`  ${ansis.bold('Binary')}         ${binaryVer}`)
  console.log(`  ${ansis.bold('Frontend')}       ${frontend}`)
  console.log(`  ${ansis.bold('Backend')}        ${backend}`)
  console.log(`  ${ansis.bold('MCP')}            ${mcpServers.length > 0 ? mcpServers.join(', ') : ansis.gray('none')}`)
  console.log(`  ${ansis.bold('Codex mode')}     ${codexMode ? 'installed' : ansis.gray('not installed')}`)
  console.log(`  ${ansis.bold('Active tasks')}   ${activeTasks > 0 ? ansis.yellow(String(activeTasks)) : '0'}`)
  console.log()
}
