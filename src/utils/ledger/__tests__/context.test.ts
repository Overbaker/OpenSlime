import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { computeContext } from '../context'
import { projectLog } from '../paths'
import { resolveProject } from '../project'
import { appendEvent, readLog } from '../store'
import { stageEvent, tmp } from './fixtures'

function world() {
  const base = tmp()
  const home = join(base, 'home')
  const installDir = join(home, '.claude')
  const root = join(base, 'proj')
  mkdirSync(join(root, 'openspec'), { recursive: true })
  mkdirSync(installDir, { recursive: true })
  return { base, home, installDir, root }
}

function put(path: string, body: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

describe('observed context', () => {
  it('reads output style by precedence, hashes CLAUDE.md and rules, lists skills and MCP server names', () => {
    const w = world()
    put(join(w.installDir, 'settings.json'), JSON.stringify({ outputStyle: 'engineer-professional' }))
    put(join(w.root, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'explanatory' }))
    put(join(w.installDir, 'CLAUDE.md'), 'user rules')
    put(join(w.installDir, 'rules', 'a.md'), 'rule a')
    put(join(w.installDir, 'skills', 'tdd', 'SKILL.md'), '---')
    put(join(w.installDir, 'skills', 'not-a-skill', 'README.md'), 'x')
    put(join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { context7: { command: '/usr/bin/x', env: { TOKEN: 'secret123' } } }, projects: { [w.root]: { mcpServers: { 'local-db': {} } } } }))
    put(join(w.root, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { url: 'https://internal.example/x' } } }))
    const c = computeContext({ installDir: w.installDir, projectRoot: join(w.root, 'openspec'), home: w.home })
    expect(c.output_style).toBe('explanatory')
    expect(c.claude_md.user).toMatch(/^[0-9a-f]{12}$/)
    expect(c.claude_md.project).toBeNull()
    expect(c.rules.user).toMatch(/^[0-9a-f]{12}$/)
    expect(c.rules.project).toBeNull()
    expect(c.skills).toEqual({ user: ['tdd'], project: [], total: 1 })
    expect(c.mcp_servers).toEqual({ user: ['context7'], local: ['local-db'], project: ['playwright'], total: 3 })
    expect(c.digest).toMatch(/^[0-9a-f]{16}$/)
  })

  it('Q4: never stores MCP config values or the project path', () => {
    const w = world()
    put(join(w.root, '.mcp.json'), JSON.stringify({ mcpServers: { svc: { command: '/opt/secret/bin', env: { TOKEN: 'secret123' }, url: 'https://internal.example/x' }, [`${w.root}/srv`]: {} } }))
    const opts = { root: join(w.base, 'ledger'), installDir: w.installDir, projectRoot: w.root, version: 't', env: {} }
    appendEvent(stageEvent(), opts)
    const line = readFileSync(projectLog(opts.root, resolveProject(w.root).id), 'utf8')
    for (const leak of ['secret123', '/opt/secret', 'internal.example', w.root]) expect(line).not.toContain(leak)
    expect(line).toContain('"svc"')
    expect(line).toContain('"(path)"')
  })

  it('Q3: a retry after the environment changes is still a duplicate; non-stage events carry no context', () => {
    const w = world()
    const opts = { root: join(w.base, 'ledger'), installDir: w.installDir, projectRoot: w.root, version: 't', env: {} }
    expect(appendEvent(stageEvent(), opts)).toMatchObject({ receipt: { status: 'appended' } })
    put(join(w.installDir, 'skills', 'new-skill', 'SKILL.md'), '---')
    put(join(w.root, 'CLAUDE.md'), 'changed')
    expect(appendEvent(stageEvent(), opts)).toMatchObject({ receipt: { status: 'duplicate' } })
    const events = readLog(projectLog(opts.root, resolveProject(w.root).id)).events
    expect(events).toHaveLength(1)
    expect((events[0] as any).context.skills.user).toEqual([])
  })

  it('Q5: deterministic and capped; unreadable files fail to null, never the append', () => {
    const w = world()
    for (let i = 0; i < 150; i++) put(join(w.installDir, 'skills', `s${String(i).padStart(3, '0')}`, 'SKILL.md'), '---')
    put(join(w.root, '.mcp.json'), '{ not json')
    put(join(w.root, '.claude', 'settings.json'), '{ broken')
    const a = computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home })
    const b = computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home })
    expect(a).toEqual(b)
    expect(a.skills!.user).toHaveLength(100)
    expect(a.skills!.total).toBe(150)
    expect(a.mcp_servers.project).toBeNull()
    expect(a.output_style).toBeNull()
  })

  it('bounds name length, ignores hidden and deep rule dirs, and never fails an append over a huge context', () => {
    const w = world()
    put(join(w.installDir, 'rules', 'a.md'), 'rule')
    put(join(w.installDir, 'rules', '.git', 'refs', 'remotes', 'origin', 'x'), 'ref')
    put(join(w.installDir, 'rules', 'd1', 'd2', 'd3', 'd4', 'deep.md'), 'deep')
    const servers = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${'s'.repeat(700)}${i}`, {}]))
    put(join(w.root, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
    put(join(w.root, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'x'.repeat(70000) }))
    const c = computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home })
    expect(c.rules.user).toMatch(/^[0-9a-f]{12}$/)
    expect(c.output_style).toBe('(long)')
    expect(c.mcp_servers.project).toEqual(['(long)'])
    const opts = { root: join(w.base, 'ledger'), installDir: w.installDir, projectRoot: w.root, version: 't', env: {} }
    const big = stageEvent()
    big.payload.invocations = Array.from({ length: 52 }, (_, i) => ({ ...big.payload.invocations[0], backend: `b${i}`, skills: Array.from({ length: 20 }, (_, j) => `skill-${'k'.repeat(40)}-${j}`) }))
    expect(appendEvent(big, opts)).toMatchObject({ receipt: { status: 'appended' } })
    const stored = readLog(projectLog(opts.root, resolveProject(w.root).id)).events.at(-1) as any
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeGreaterThan(60_000)
    const odd = computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home })
    expect(odd.output_style).toBe('(long)')
    put(join(w.root, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'a\u0001b' }))
    expect(computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home }).output_style).toBe('(odd)')
    // A payload just under the cap plus a sizeable context: the context is dropped, the append still succeeds.
    for (let i = 0; i < 100; i++) put(join(w.installDir, 'skills', `skill-${'q'.repeat(50)}-${i}`, 'SKILL.md'), '---')
    const near = stageEvent({ operation_key: 'near' })
    near.payload.invocations = Array.from({ length: 55 }, (_, i) => ({ ...near.payload.invocations[0], backend: `b${i}`, skills: Array.from({ length: 20 }, (_, j) => `skill-${'k'.repeat(40)}-${j}`) }))
    expect(appendEvent(near, opts)).toMatchObject({ receipt: { status: 'appended' } })
    expect('context' in (readLog(projectLog(opts.root, resolveProject(w.root).id)).events.at(-1) as any)).toBe(false)
  })

  it('counts skills installed as symlinks (as the managed skill store does)', () => {
    const w = world()
    put(join(w.base, 'store', 'tdd', 'SKILL.md'), '---')
    mkdirSync(join(w.installDir, 'skills'), { recursive: true })
    symlinkSync(join(w.base, 'store', 'tdd'), join(w.installDir, 'skills', 'ccg-tdd'), 'junction')
    expect(computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home }).skills!.user).toEqual(['ccg-tdd'])
  })
})


describe('review fixes: MCP scopes', () => {
  it('treats a missing ~/.claude.json as no servers, finds local servers by launch dir, and an unknown project as null', () => {
    const w = world()
    expect(computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home }).mcp_servers).toEqual({ user: [], local: [], project: [], total: 0 })
    const sub = join(w.root, 'packages', 'web')
    mkdirSync(sub, { recursive: true })
    put(join(w.home, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: { [sub]: { mcpServers: { db: {} } } } }))
    expect(computeContext({ installDir: w.installDir, projectRoot: sub, home: w.home }).mcp_servers.local).toEqual(['db'])
    expect(computeContext({ installDir: w.installDir, projectRoot: w.root, home: w.home }).mcp_servers.local).toBeNull()
  })

  it('uses HOME from the append env to find ~/.claude.json', () => {
    const w = world()
    put(join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { 'env-home-server': {} } }))
    const r = appendEvent(stageEvent(), { root: join(w.base, 'ledger'), installDir: w.installDir, projectRoot: w.root, version: 't', env: { HOME: w.home } })
    expect(r.code).toBe(0)
    const line = readLog(projectLog(join(w.base, 'ledger'), resolveProject(w.root).id)).events[0] as any
    expect(line.context.mcp_servers.user).toEqual(['env-home-server'])
  })
})

describe('review fixes: local MCP lookup walks up', () => {
  it('uses the nearest ancestor with a projects entry between cwd and the git root', () => {
    const w = world()
    const launch = join(w.root, 'pkg')
    const cwd = join(launch, 'src')
    mkdirSync(cwd, { recursive: true })
    put(join(w.home, '.claude.json'), JSON.stringify({ projects: { [launch]: { mcpServers: { db: {} } }, [w.root]: { mcpServers: {} } } }))
    expect(computeContext({ installDir: w.installDir, projectRoot: cwd, home: w.home }).mcp_servers.local).toEqual(['db'])
  })
})
