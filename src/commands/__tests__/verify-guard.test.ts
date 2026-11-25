import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../../cli.ts', import.meta.url))
const loader = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href
let repo: string

function git(...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), content)
}

function guard(...args: string[]) {
  return spawnSync(process.execPath, ['--import', loader, entry, 'verify-guard', ...args], { cwd: repo, encoding: 'utf8' })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'osm-guard-'))
  git('init', '-q')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@example.test')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

it('P8 and P9: reports each base-file mutation reproducibly across index and worktree', () => {
  const cases = [
    ['test/a.ts', 'expect(x)', 'it.skip('],
    ['test suite/x.test.js', 'assert(x)', 'it.only('],
    ['lib/tests/a.ts', 't.Errorf(x)', 'xit('],
    ['lib/__tests__/a.ts', 'assert.ok(x)', 'xdescribe('],
    ['a.spec.js', 'value.should.equal(x)', 'it.skip('],
    ['core_test.go', 't.Fatal(x)', 't.Skip('],
    ['test_core.py', 'assert x', '@pytest.mark.skip'],
    ['lib/tests/b.ts', 'require.True(x)', 'xit('],
  ]
  for (const [path, assertion] of cases) write(path, `setup\n${assertion}\n`)
  write('tests/deleted', '')
  write('src/ordinary.ts', 'assert(x)\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  expect(guard('--base', 'HEAD')).toMatchObject({ status: 0, stdout: '' })
  for (const [path, , skip] of cases) write(path, `setup\n${skip}\n`)
  write('src/ordinary.ts', 'pass\n')
  git('add', cases[0][0])
  git('rm', '-q', 'tests/deleted')
  write('tests/staged', 'it.skip(\n')
  git('add', 'tests/staged')
  write('tests/untracked', '@pytest.mark.skip\n')
  const index = git('ls-files', '--stage')
  const run = guard('--base', 'HEAD')
  expect(run.status).toBe(1)
  const expected = cases.flatMap(([path]) => [`${path}:2 removed-assertion`, `${path}:2 added-skip-or-only`])
  expect(run.stdout.trimEnd().split('\n').sort()).toEqual([...expected, 'tests/deleted:1 deleted-test-file'].sort())
  expect(guard('--base', 'HEAD')).toMatchObject({ status: 1, stdout: run.stdout })
  expect(git('ls-files', '--stage')).toBe(index)
}, 30_000)

it('checks changed numeric literals in named files only and ignores committed additions since base', () => {
  for (const path of ['ci/deep/check.js', 'limits.cfg', 'unselected']) write(path, 'max = 1.5\ntimeout = 200\nmin = 3\nother = 8\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  write('tests/new', 'assert x\n')
  git('add', '.')
  git('commit', '-qm', 'new test')
  write('tests/new', 'xit(\n')
  for (const path of ['ci/deep/check.js', 'limits.cfg', 'unselected']) write(path, 'max = 2.5\ntimeout = 100\nmin=3\nother = 7\n')
  expect(guard('--base', base)).toMatchObject({ status: 0, stdout: '' })
  expect(guard('--base', base, '--paths', 'ci/**/*.js', 'limits.cfg')).toMatchObject({
    status: 1,
    stdout: 'ci/deep/check.js:1 changed-threshold\nci/deep/check.js:2 changed-threshold\nlimits.cfg:1 changed-threshold\nlimits.cfg:2 changed-threshold\n',
  })
}, 30_000)

it.each([[], ['--base'], ['--base', 'missing'], ['--base', 'HEAD', '--paths']])('returns 2 for usage and git errors (%j)', (...args: string[]) => {
  const result = guard(...args)
  expect(result.status).toBe(2)
  expect(result.stderr).toBeTruthy()
})

function snapshot(): string {
  const result = guard('--print-tree')
  expect(result).toMatchObject({ status: 0, stderr: '' })
  const tree = result.stdout.trim()
  expect(git('cat-file', '-t', tree).trim()).toBe('tree')
  return tree
}

it('snapshots an unborn worktree, including untracked files, without creating an index', () => {
  write('test_first.py', 'assert ready\n')
  const tree = snapshot()
  expect(git('show', `${tree}:test_first.py`)).toBe('assert ready\n')
  expect(guard('--base', tree)).toMatchObject({ status: 0, stdout: '' })
  write('test_first.py', 'pass\n')
  expect(guard('--base', tree)).toMatchObject({ status: 1, stdout: 'test_first.py:1 removed-assertion\n' })
  expect(existsSync(join(repo, '.git/index'))).toBe(false)
})

it('snapshots unstaged edits and deletions while preserving the real index byte for byte', () => {
  write('test_one.py', 'assert staged\n')
  write('obsolete', 'staged')
  git('add', '.')
  write('test_one.py', 'assert current\n')
  rmSync(join(repo, 'obsolete'))
  const index = readFileSync(join(repo, '.git/index'))
  const tree = snapshot()
  expect(git('ls-tree', '--name-only', tree)).toBe('test_one.py\n')
  expect(git('show', `${tree}:test_one.py`)).toBe('assert current\n')
  expect(snapshot()).toBe(tree)
  expect(readFileSync(join(repo, '.git/index'))).toEqual(index)
})

it('compares renamed tests and cancels moved assertions up to their multiplicity', () => {
  const filler = Array.from({ length: 20 }, (_, i) => `prepare(${i})\n`).join('')
  write('tests/old', `expect(a)\nexpect(a)\nassert.ok(b)\n${filler}`)
  const tree = snapshot()
  renameSync(join(repo, 'tests/old'), join(repo, 'tests/new'))
  write('tests/new', `${filler}  assert.ok(b)\n  expect(a)\nexpect(a)\n`)
  expect(guard('--base', tree)).toMatchObject({ status: 0, stdout: '' })
  write('tests/new', `${filler}  assert.ok(b)\nexpect(a)\ntest.todo('repair')\n`)
  const run = guard('--base', tree)
  expect(run.status).toBe(1)
  expect(run.stdout.trimEnd().split('\n')).toEqual(['tests/old:2 removed-assertion', 'tests/new:23 added-skip-or-only'])
})

it('recognizes assertion tokens and ignores prose, near matches and pure comments', () => {
  const assertions = ['expect(a)', 'assert(a)', 'assert.equal(a)', 't.Error(x)', 't.Errorf(x)', 't.Fatal(x)', 't.Fatalf(x)', 't.Fail()', 't.FailNow()', 'require.True(x)', 'x.should.equal(y)', 'self.assertEqual(x, y)', '  assert x']
  const others = ['// assert(x)', '# self.assertTrue(x)', '/*', 'expect(x)', '*/', 'should work', 'reassert(a)', 't.Failure(x)', 'require.member', 'assertion(x)', 'print("expect(x)")']
  write('tests/check', [...assertions, ...others].join('\n'))
  const tree = snapshot()
  write('tests/check', '')
  expect(guard('--base', tree)).toMatchObject({ status: 1, stdout: assertions.map((_, i) => `tests/check:${i + 1} removed-assertion\n`).join('') })
})

it('reports each skip marker in tests and ignores the same markers in application code', () => {
  const markers = ['it.skip(', 'it.skip.each(', 'it.skipIf(', 'it.only(', 'xit(', 'xdescribe(', 'xtest(', 'test.todo(', '@pytest.mark.skip', '@pytest.mark.skipif', 'pytest.skip(', 't.Skip(', 't.Skipf(', 't.SkipNow(']
  for (const path of ['tests/check', 'src/check']) write(path, '')
  const tree = snapshot()
  for (const path of ['tests/check', 'src/check']) write(path, [...markers, '// t.Skip()', '/* test.todo() */', 'log("t.Skip()")'].join('\n'))
  expect(guard('--base', tree)).toMatchObject({ status: 1, stdout: markers.map((_, i) => `tests/check:${i + 1} added-skip-or-only\n`).join('') })
})

it('pairs threshold edits across distant hunks of the same file', () => {
  const middle = Array.from({ length: 24 }, (_, i) => `setup${i}\n`).join('')
  write('ci/options', `timeout = 3\nlimit = 8\n${middle}`)
  const tree = snapshot()
  write('ci/options', `${middle}limit = 8\ntimeout = 9\n`)
  expect(guard('--base', tree, '--paths', 'ci/**')).toMatchObject({ status: 1, stdout: 'ci/options:26 changed-threshold\n' })
})

it('reports the old test path when a rename removes its directory or filename test marker', () => {
  write('tests/helper.js', 'assert(helper)\n')
  write('worker.test.js', 'assert(worker)\n')
  const tree = snapshot()
  renameSync(join(repo, 'tests/helper.js'), join(repo, 'helper.js'))
  renameSync(join(repo, 'worker.test.js'), join(repo, 'worker.js'))
  const run = guard('--base', tree)
  expect(run.status).toBe(1)
  expect(run.stdout.trimEnd().split('\n').sort()).toEqual(['tests/helper.js:1 deleted-test-file', 'worker.test.js:1 deleted-test-file'])
})

it('reports unreplaced thresholds at their base lines alongside changed values', () => {
  write('ci/check', 'timeout = 3\nmin_score = 90\nlimit = 5\n')
  write('ci/deleted', 'threshold = 7\n')
  write('unselected', 'max = 10\n')
  const tree = snapshot()
  write('ci/check', 'timeout = 6\nmax_workers = 90\n')
  rmSync(join(repo, 'ci/deleted'))
  rmSync(join(repo, 'unselected'))
  const run = guard('--base', tree, '--paths', 'ci/**')
  expect(run.status).toBe(1)
  expect(run.stdout.trimEnd().split('\n').sort()).toEqual(['ci/check:1 changed-threshold', 'ci/check:2 removed-threshold', 'ci/check:3 removed-threshold', 'ci/deleted:1 removed-threshold'])
})

it('reports module and suite skips, including pytestmark assignments and lists', () => {
  const files = {
    'test_direct.py': ['pytestmark = pytest.mark.skip'],
    'test_list.py': ['pytestmark = [pytest.mark.skipif(True, reason="offline")]'],
    'test_multiline.py': ['pytestmark = [', '    pytest.mark.skip,', ']', 'marker = pytest.mark.skip'],
    'test_call.py': ['pytest.skip("offline", allow_module_level=True)'],
    'suite.test.js': ['describe.skip("suite", fn)', 'test.skip("case", fn)'],
    'suite_test.go': ['t.Skip("offline")'],
  }
  for (const path of Object.keys(files)) write(path, '')
  const tree = snapshot()
  for (const [path, lines] of Object.entries(files)) write(path, lines.join('\n'))
  const run = guard('--base', tree)
  expect(run.status).toBe(1)
  expect(run.stdout.trimEnd().split('\n').sort()).toEqual([
    'suite.test.js:1', 'suite.test.js:2', 'suite_test.go:1', 'test_call.py:1', 'test_direct.py:1', 'test_list.py:1', 'test_multiline.py:2',
  ].map(location => `${location} added-skip-or-only`))
})
