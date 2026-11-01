import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'pathe'
import { canonicalJson, sha256Hex } from './canonical'
import { containsAbsolutePath } from './schema'

/** What the CLI can observe about the user's setup at append time. Names only; config values are never read into it. */
export interface ObservedContext {
  v: 1
  output_style: string | null
  claude_md: { user: string | null, project: string | null, project_dot: string | null, local: string | null }
  rules: { user: string | null, project: string | null }
  skills: { user: string[], project: string[], total: number } | null
  mcp_servers: { user: string[] | null, local: string[] | null, project: string[] | null, total: number }
  digest: string
}

export const MAX_NAMES = 100
const MAX_RULE_FILES = 500
const MAX_RULE_DEPTH = 4
const MAX_CLAUDE_JSON = 5 * 1024 * 1024
const MAX_NAME = 64

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  }
  catch {
    return fallback
  }
}

function sha12(path: string): string | null {
  return attempt(() => sha256Hex(readFileSync(path), 12), null)
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The nearest ancestor with `.git` (file or dir), else `openspec/`, else the start. Located only; never stored. */
export function contextRoot(start: string): string {
  const from = resolve(start)
  for (const marker of ['.git', 'openspec']) {
    let dir = from
    while (true) {
      if (existsSync(join(dir, marker))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return from
}

/** Bounded and path-free, so the snapshot can never push an event past the line cap. */
function cleanName(name: string): string {
  if (containsAbsolutePath(name)) return '(path)'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) return '(odd)'
  return [...name].length > MAX_NAME ? '(long)' : name
}

function names(list: string[]): string[] {
  return [...new Set(list.map(cleanName))].sort().slice(0, MAX_NAMES)
}

function outputStyle(root: string, installDir: string): string | null {
  for (const path of [join(root, '.claude', 'settings.local.json'), join(root, '.claude', 'settings.json'), join(installDir, 'settings.json')]) {
    if (!existsSync(path)) continue
    let settings: any
    try {
      settings = readJson(path)
    }
    catch {
      return null
    }
    if (typeof settings?.outputStyle === 'string') return cleanName(settings.outputStyle)
  }
  return 'default'
}

function rulesHash(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files: Record<string, string | null> = {}
  let count = 0
  const walk = (d: string, depth: number): boolean => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        // Hidden directories (.git and the like) hold no rules; deeper directories are ignored, not fatal.
        if (entry.name.startsWith('.') || depth >= MAX_RULE_DEPTH) continue
        if (!walk(p, depth + 1)) return false
      }
      else if (entry.name.endsWith('.md')) {
        if (++count > MAX_RULE_FILES) return false
        files[relative(dir, p)] = sha12(p)
      }
    }
    return true
  }
  return attempt(() => (walk(dir, 1) ? sha256Hex(canonicalJson(files), 12) : null), null)
}

/** Follows symlinks: managed skills are installed as links to a shared store. */
function skillNames(dir: string): string[] {
  return attempt(() => readdirSync(dir)
    .filter(name => attempt(() => statSync(join(dir, name)).isDirectory(), false) && existsSync(join(dir, name, 'SKILL.md'))), [])
}

function serverKeys(obj: any): string[] | null {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : null
}

function mcpServers(root: string, start: string, home: string | null): ObservedContext['mcp_servers'] {
  let user: string[] | null = null
  let local: string[] | null = null
  attempt(() => {
    if (!home) return
    const claudeJson = join(home, '.claude.json')
    // No ~/.claude.json means no user or local servers, which is known; an unreadable one stays null.
    if (!existsSync(claudeJson)) {
      user = []
      local = []
      return
    }
    if (statSync(claudeJson).size > MAX_CLAUDE_JSON) return
    // Only keys are kept: server commands, args, env and urls are dropped with the parsed object.
    const parsed = readJson(claudeJson)
    user = serverKeys(parsed?.mcpServers) ?? []
    // Claude Code keys local servers by the launch directory, which may sit below the git root.
    let entry
    for (let dir = resolve(start); entry === undefined; dir = dirname(dir)) {
      entry = parsed?.projects?.[dir]
      if (dir === root || dirname(dir) === dir) break
    }
    local = entry === undefined ? null : serverKeys(entry?.mcpServers) ?? []
  }, undefined)
  const project = attempt(() => (existsSync(join(root, '.mcp.json')) ? serverKeys(readJson(join(root, '.mcp.json')).mcpServers) ?? [] : []), null)
  const all = [user, local, project] as Array<string[] | null>
  const total = new Set(all.flatMap(l => l ?? [])).size
  return { user: user && names(user), local: local && names(local), project: project && names(project), total }
}

/**
 * The observed snapshot attached to stage_completed events. Every reader fails to null and never fails the append;
 * the absolute project root is used to locate files and is never stored.
 */
export function computeContext(opts: { installDir: string, projectRoot: string, home?: string }): ObservedContext {
  const root = contextRoot(opts.projectRoot)
  const home = opts.home ?? attempt<string | null>(() => homedir(), null)
  const userSkills = skillNames(join(opts.installDir, 'skills'))
  const projectSkills = skillNames(join(root, '.claude', 'skills'))
  const body = {
    v: 1 as const,
    output_style: attempt(() => outputStyle(root, opts.installDir), null),
    claude_md: {
      user: sha12(join(opts.installDir, 'CLAUDE.md')),
      project: sha12(join(root, 'CLAUDE.md')),
      project_dot: sha12(join(root, '.claude', 'CLAUDE.md')),
      local: sha12(join(root, 'CLAUDE.local.md')),
    },
    rules: { user: rulesHash(join(opts.installDir, 'rules')), project: rulesHash(join(root, '.claude', 'rules')) },
    skills: { user: names(userSkills), project: names(projectSkills), total: new Set([...userSkills, ...projectSkills]).size },
    mcp_servers: mcpServers(root, opts.projectRoot, home),
  }
  return { ...body, digest: sha256Hex(canonicalJson(body), 16) }
}
