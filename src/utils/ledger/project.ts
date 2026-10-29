import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'pathe'

/** git was interrupted: a transient failure, not a bad project root. */
export class ProjectInterruptedError extends Error {}

export interface ProjectIdentity {
  id: string
  name: string
}

function gitCommonDir(cwd: string): string | null {
  try {
    // `--path-format` needs git 2.31; older git echoes it back, so resolve the plain output against cwd.
    const lines = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter(Boolean)
    const out = lines.at(-1)
    return out ? normalize(realpathSync(resolve(cwd, out))) : null
  }
  catch (error: any) {
    // Killed by a signal (e.g. Ctrl-C reaching the process group) is not "no repo": guessing would file the event under another id.
    if (error?.signal) throw new ProjectInterruptedError(`git rev-parse interrupted by ${error.signal}`)
    return null
  }
}

function openspecAncestor(start: string): string | null {
  let dir = start
  while (true) {
    if (existsSync(join(dir, 'openspec'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function projectName(key: string, isGit: boolean): string {
  // For a git repo the key is `<repo>/.git` (or a bare `<repo>.git`); name the repo, not `.git`.
  if (!isGit) return basename(key)
  const base = basename(key)
  return base === '.git' ? basename(dirname(key)) : base.replace(/\.git$/, '')
}

export function resolveProject(cwd: string = process.cwd()): ProjectIdentity {
  const real = normalize(realpathSync(resolve(cwd)))
  const common = gitCommonDir(real)
  const key = common ?? openspecAncestor(real) ?? real
  const id = `p_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
  return { id, name: projectName(key, common !== null) }
}
