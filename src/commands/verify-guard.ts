import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testPath = /(?:^|\/)(?:__tests__|tests?)\/|(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:[^/]*_test\.go|test_[^/]*\.py)$/
const assertion = /\bexpect\(|\bassert(?:\.\w+)?\(|\bt\.(?:Errorf?|Fatalf?|Fail|FailNow)\(|\brequire\.\w+\(|\.should\.|\bself\.assert\w*\(|^\s*assert\s/
const skip = /\.(?:skip|skipIf|only)\(|\.skip\.each\b|\b(?:xit|xdescribe|xtest|test\.todo|pytest\.skip|t\.Skip(?:f|Now)?)\(|@pytest\.mark\.skip(?:if)?\b/
const threshold = /threshold|timeout|max|min|limit/i
const numberLiteral = /(?<![\w.])[+-]?(?:0x[\da-f_]+|0b[01_]+|0o[0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?\d[\d_]*)?)/gi

interface LimitLine {
  line: number
  shape: string
  names: string
  numbers: string
}

function limitLine(text: string, line: number): LimitLine | undefined {
  if (!threshold.test(text)) return
  const numbers = text.match(numberLiteral)
  if (!numbers) return
  const names = (text.match(/[\w$]+/g) ?? []).filter(word => threshold.test(word)).join(' ')
  return { line, shape: text.replace(numberLiteral, '#').trim(), names, numbers: numbers.join(' ') }
}

interface ChangedLine {
  number: number
  text: string
}

function changedLines(patch: string) {
  const removed: ChangedLine[] = []
  const added: ChangedLine[] = []
  for (const hunk of patch.split(/^@@ -/m).slice(1)) {
    const [header, ...lines] = hunk.split('\n')
    const range = /^(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header)
    if (!range) throw new Error('invalid git diff hunk')
    let oldLine = Number(range[1])
    let newLine = Number(range[2])
    for (const line of lines) {
      if (line.startsWith('-')) removed.push({ number: oldLine++, text: line.slice(1) })
      else if (line.startsWith('+')) added.push({ number: newLine++, text: line.slice(1) })
      else if (line.startsWith(' ')) {
        oldLine++
        newLine++
      }
    }
  }
  return { removed, added }
}

function thresholds(oldPath: string, path: string, oldLines: ChangedLine[], newLines: ChangedLine[]): string[] {
  const limits = (lines: ChangedLine[]) => lines.flatMap(({ number, text }) => limitLine(text, number) ?? [])
  const removed = limits(oldLines)
  const added = limits(newLines)
  const findings: string[] = []
  const unmatched: LimitLine[] = []
  for (const limit of added) {
    const index = removed.findIndex(old => old.shape === limit.shape)
    if (index < 0) unmatched.push(limit)
    else if (removed.splice(index, 1)[0].numbers !== limit.numbers) findings.push(`${path}:${limit.line} changed-threshold`)
  }
  for (const limit of unmatched) {
    const index = removed.findIndex(old => old.names === limit.names)
    if (index >= 0 && removed.splice(index, 1)[0].numbers !== limit.numbers) findings.push(`${path}:${limit.line} changed-threshold`)
  }
  for (const limit of removed) findings.push(`${oldPath}:${limit.line} removed-threshold`)
  return findings
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 })
}

function currentTree(root: string): string {
  const index = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trimEnd()
  const dir = mkdtempSync(join(tmpdir(), 'osm-index-'))
  const tempIndex = join(dir, 'index')
  try {
    try {
      copyFileSync(index, tempIndex)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const options = { cwd: root, env: { ...process.env, GIT_INDEX_FILE: tempIndex }, encoding: 'utf8' as const }
    execFileSync('git', ['add', '-A'], options)
    return execFileSync('git', ['write-tree'], options).trim()
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function codeLines(content: string) {
  const token = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/|#|\/\*/g
  let markListDepth = 0
  let blockComment = false
  return content.split('\n').map((line) => {
    let normalized = ''
    let code = ''
    let start = 0
    while (start < line.length) {
      if (blockComment) {
        const end = line.indexOf('*/', start)
        if (end < 0) break
        start = end + 2
        blockComment = false
      }
      token.lastIndex = start
      const match = token.exec(line)
      const segment = line.slice(start, match?.index ?? line.length).replace(/\s+/g, ' ')
      code += segment
      normalized += segment
      if (!match || match[0] === '//' || match[0] === '#') break
      if (match[0] === '/*') blockComment = true
      else {
        normalized += match[0]
        code += '""'
      }
      start = token.lastIndex
    }
    const markAssignment = /^\s*pytestmark\s*=\s*/.exec(code)
    const value = markAssignment ? code.slice(markAssignment[0].length) : code
    const markList = markListDepth > 0 || (markAssignment && value.startsWith('['))
    const moduleSkip = markList
      ? /\bpytest\.mark\.skip(?:if)?\b/.test(value)
      : Boolean(markAssignment && /^pytest\.mark\.skip(?:if)?\b/.test(value))
    if (markList) markListDepth += (value.match(/\[/g)?.length ?? 0) - (value.match(/\]/g)?.length ?? 0)
    return { normalized: normalized.trim(), assertion: assertion.test(code), skip: skip.test(code) || moduleSkip }
  })
}

type TestLines = ReturnType<typeof codeLines>

function assertionRemovals(path: string, before: TestLines, after: TestLines, removed: ChangedLine[]): string[] {
  const counts = new Map<string, number>()
  for (const line of after) {
    if (line.assertion) counts.set(line.normalized, (counts.get(line.normalized) ?? 0) + 1)
  }
  const changed = new Set(removed.map(line => line.number))
  const baseLines = before.flatMap((line, i) => line.assertion ? [{ key: line.normalized, number: i + 1 }] : [])
  baseLines.sort((a, b) => Number(changed.has(a.number)) - Number(changed.has(b.number)))
  const findings: string[] = []
  for (const { key, number } of baseLines) {
    const count = counts.get(key) ?? 0
    if (count) counts.set(key, count - 1)
    else findings.push(`${path}:${number} removed-assertion`)
  }
  return findings
}

function treeFindings(root: string, base: string, current: string, paths: string[]): string[] {
  const diff = ['diff-tree', '-r', '--find-renames', '--no-ext-diff', '--unified=0', '--no-commit-id', '--no-color', '--no-textconv', '--no-relative', '--inter-hunk-context=0']
  const statuses = git(root, ...diff, '--name-status', '-z', base, current, '--').split('\0')
  const limits = paths.length
    ? new Set(git(root, ...diff, '--name-only', '-z', base, current, '--', ...paths.map(path => `:(glob)${path}`)).split('\0'))
    : new Set<string>()
  const findings: string[] = []
  for (let i = 0; i < statuses.length - 1;) {
    const status = statuses[i++]
    const oldPath = statuses[i++]
    const renamed = status.startsWith('R')
    const path = renamed ? statuses[i++] : oldPath
    if (status === 'A') continue
    const test = testPath.test(oldPath) || testPath.test(path)
    if (!test && !limits.has(path) && !limits.has(oldPath)) continue
    const names = renamed ? [oldPath, path] : [path]
    const patch = git(root, '--literal-pathspecs', ...diff, '-p', base, current, '--', ...names)
    const { removed, added } = changedLines(patch)
    if (test) {
      if (status === 'D' || (renamed && !testPath.test(path))) findings.push(`${oldPath}:1 deleted-test-file`)
      const before = codeLines(git(root, 'show', `${base}:${oldPath}`))
      const after = status === 'D' ? [] : codeLines(git(root, 'show', `${current}:${path}`))
      for (const finding of assertionRemovals(oldPath, before, after, removed)) findings.push(finding)
      if (testPath.test(path)) {
        for (const line of added) {
          if (after[line.number - 1]?.skip) findings.push(`${path}:${line.number} added-skip-or-only`)
        }
      }
    }
    if (limits.has(path) || limits.has(oldPath)) {
      for (const finding of thresholds(oldPath, path, removed, added)) findings.push(finding)
    }
  }
  return findings
}

export function verifyGuard(base: string | undefined, paths: string[], printTree = false): number {
  try {
    if ((printTree ? base !== undefined || paths.length : !base) || paths.some(path => !path))
      throw new Error('usage: osm verify-guard --print-tree | --base <tree-ish> [--paths <glob>...]')
    const root = git(process.cwd(), 'rev-parse', '--show-toplevel').replace(/\r?\n$/, '')
    const current = currentTree(root)
    if (printTree) {
      process.stdout.write(`${current}\n`)
      return 0
    }
    const tree = git(root, 'rev-parse', '--verify', '--end-of-options', `${base}^{tree}`).trim()
    const findings = treeFindings(root, tree, current, paths)
    if (!findings.length) return 0
    process.stdout.write(`${findings.join('\n')}\n`)
    return 1
  }
  catch (error) {
    process.stderr.write(`verify-guard: ${error instanceof Error ? error.message : error}\n`)
    return 2
  }
}
