import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { resolveProject } from '../project'
import { tmp } from './fixtures'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

describe('resolveProject', () => {
  it('gives a repo and its linked worktree the same id, and clones different ids', () => {
    const base = tmp()
    const repo = join(base, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'a')
    git(repo, 'worktree', 'add', '-q', '--detach', join(base, 'wt'))
    git(base, 'clone', '-q', repo, join(base, 'clone'))

    const main = resolveProject(repo)
    expect(main.id).toMatch(/^p_[0-9a-f]{16}$/)
    expect(main.name).toBe('repo')
    expect(resolveProject(join(base, 'wt')).id).toBe(main.id)
    expect(resolveProject(join(repo, '.git')).id).toBe(main.id)
    expect(resolveProject(join(base, 'clone')).id).not.toBe(main.id)
  })

  it('falls back to the nearest openspec ancestor, then cwd', () => {
    const base = tmp()
    mkdirSync(join(base, 'proj', 'openspec'), { recursive: true })
    mkdirSync(join(base, 'proj', 'src', 'deep'), { recursive: true })
    const a = resolveProject(join(base, 'proj', 'src', 'deep'))
    expect(a).toEqual(resolveProject(join(base, 'proj')))
    expect(a.name).toBe('proj')
    mkdirSync(join(base, 'loose'))
    expect(resolveProject(join(base, 'loose')).name).toBe('loose')
  })
})
