import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { getAllCommandIds, installWorkflows } from '../installer'
import { PACKAGE_ROOT } from '../installer-template'

const read = (rel: string) => readFileSync(join(PACKAGE_ROOT, 'templates', rel), 'utf8')
const square2Prompt = read('prompts/claude/osm-square2.md')

function extractSections(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^## ([^\n]+)$/gm)].map(m => m[1].trim()))
}

function sectionBody(markdown: string, heading: string): string {
  const m = markdown.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))
  return m ? m[1] : ''
}

function validateSquare2Reference(content: string, validSections: ReadonlySet<string>): { ok: boolean, section: string | null, reason?: string } {
  const occurrences = content.match(/osm-square2\.md/g) ?? []
  if (occurrences.length !== 1) return { ok: false, section: null, reason: `expected 1 osm-square2.md reference, found ${occurrences.length}` }
  const lines = content.split('\n').filter(line => line.includes('osm-square2.md'))
  if (lines.length !== 1) return { ok: false, section: null, reason: `expected 1 line referencing osm-square2.md, found ${lines.length}` }
  const sectionMatch = lines[0].match(/§([A-Za-z]+)/)
  if (!sectionMatch) return { ok: false, section: null, reason: 'missing §<Section> on osm-square2.md line' }
  const section = sectionMatch[1]
  if (!validSections.has(section)) return { ok: false, section, reason: `unknown section §${section}` }
  return { ok: true, section }
}

describe('P10: osm-square2.md sections and single-reference command template invariant', () => {
  const sections = extractSections(square2Prompt)

  it('defines all required sections and concrete commands with full osm paths (L-0004)', () => {
    for (const heading of ['Detect', 'Versions', 'Research', 'Plan', 'Impl', 'Review', 'Correct']) {
      expect(sections.has(heading), `missing ## ${heading}`).toBe(true)
    }
    for (const token of [
      'node tools/square2/bin/square2.mjs',
      'osm-sq2',
      '~/.claude/bin/osm ledger hash-report',
      '~/.claude/bin/osm verify-guard --base "$base_tree" --paths',
      'SQUARE2_DIR',
      'enabled: false',
    ]) {
      expect(square2Prompt).toContain(token)
    }
    // L-0004: every osm command in the role prompt uses the full ~/.claude/bin/osm path
    expect(square2Prompt).not.toMatch(/(?<!\/bin\/)\bosm (?:ledger|verify-guard)\b/)
  })

  it('Detect scans all remote-tracking refs (not default branch) and stops on stale .square2/ config branch', () => {
    const detect = sectionBody(square2Prompt, 'Detect')
    expect(detect).toContain('git for-each-ref --format=\'%(refname)\' refs/remotes')
    expect(detect).toContain('git cat-file -e "$r:.square2/config.yaml"')
    expect(detect).not.toContain('git ls-tree origin/<branch>')
    expect(detect).toContain('branch:')
    expect(detect).toContain('@{u}')
    expect(detect).toContain('git log --oneline HEAD.."origin/<cfg_branch>" -- .square2/')
    expect(detect).toContain('git fetch origin')
  })

  it('documents version normalization (strip leading v), ratchet --base check, and executable unknown-version branch', () => {
    const versions = sectionBody(square2Prompt, 'Versions')
    expect(versions).toMatch(/strip.*leading `v`/i)
    expect(versions).toContain('v0.1.0')
    expect(versions).toContain('0.1.1')
    expect(versions).toContain('check --base')

    const implSec = sectionBody(square2Prompt, 'Impl')
    expect(implSec).toContain('git merge-base HEAD "origin/<cfg_branch>"')
    expect(implSec).toContain('check --base "$base_commit" --report "$pre"')
    expect(implSec).toContain('check --base "$base_commit" --report "$post"')
    expect(implSec).toContain('[S2-BASELINE-GREW]')
    expect(implSec).toContain('[S2-EXC-MUTATED]')
    expect(implSec).toContain('rm -f "$pre"')
    expect(implSec).toContain('rm -f "$post"')
    expect(implSec).toContain('post_exit == 1')
    expect(implSec).toContain('pre_exit == 0')
    expect(implSec).toContain('post_exit == 2')
    expect(implSec).toContain('"exit_code":<post_exit>')
    expect(implSec).toContain('"new":null')
    expect(implSec).toContain('"report_sha256":null')
    expect(implSec).toContain('rules[*].baselined')
    expect(implSec).toContain('rules[*].excepted')
  })

  it('forbids putting square2 check inside frozen VERIFY in plan.md and §Plan', () => {
    const planCmd = read('commands/plan.md')
    expect(planCmd).not.toContain('square2 check')
    const planSec = sectionBody(square2Prompt, 'Plan')
    expect(planSec).toContain('CONSTRAINTS')
    expect(planSec).toMatch(/not\*\* include `square2 check` inside/i)
    expect(planSec).not.toContain('include `node tools/square2/bin/square2.mjs check` in its single-line')
  })

  it('enforces gh issue list --limit and no body in --json, base64url square2:target decode, gate rule-id scope match, and process-escape query', () => {
    const ghLines = square2Prompt.split('\n').filter(line => line.includes('gh issue list'))
    expect(ghLines.length).toBeGreaterThanOrEqual(2)
    for (const line of ghLines) {
      expect(line, line).toContain('--limit')
      const jsonMatch = line.match(/--json\s+([^\s]+)/)
      expect(jsonMatch, line).toBeTruthy()
      expect(jsonMatch![1].split(','), line).not.toContain('body')
    }
    const reviewSec = sectionBody(square2Prompt, 'Review')
    expect(reviewSec).toContain('check --base "$base_commit" --report "$rev"')
    expect(reviewSec).toContain('gh api repos/{owner}/{repo}/issues/<n> --jq \'.body\' | grep -o \'<!-- square2:[^>]*-->\'')
    expect(reviewSec).toContain('square2:target')
    expect(reviewSec).toContain('base64url')
    expect(reviewSec).toContain('.square2/rules/*.yaml')
    expect(reviewSec).toContain('layer:osm-process')
    expect(reviewSec).toContain('gate-impl-<phase>')
    expect(reviewSec).toContain('gate-review')
  })

  it('defines candidate layout rules/<id>.yaml + fixtures/<id>/{bad,good}/, temp-dir offering, committed-only born_from and cause:<slug>', () => {
    const correctSec = sectionBody(square2Prompt, 'Correct')
    expect(correctSec).toContain('rules/<id>.yaml')
    expect(correctSec).toContain('fixtures/<id>/{bad,good}/')
    expect(correctSec).toContain('osm-sq2-cand/<id>')
    expect(correctSec).toMatch(/never write.*worktree/i)
    expect(correctSec).not.toContain('.square2/candidates/')
    expect(correctSec).toContain('git blame HEAD')
    expect(correctSec).toMatch(/uncommitted.*skip rung 4/i)
    expect(correctSec).toContain('layer:osm-process')
    expect(correctSec).toContain('cause:<slug>')
  })

  it('each of research, plan, impl and review has exactly one osm-square2.md reference naming its section (not tied to default branch)', () => {
    const expected: Record<string, string> = {
      research: 'Research',
      plan: 'Plan',
      impl: 'Impl',
      review: 'Review',
    }
    for (const [cmd, section] of Object.entries(expected)) {
      const content = read(`commands/${cmd}.md`)
      const result = validateSquare2Reference(content, sections)
      expect(result, `${cmd}.md: ${result.reason ?? ''}`).toEqual({ ok: true, section })
      const refLine = content.split('\n').find(l => l.includes('osm-square2.md'))!
      expect(refLine, cmd).toContain('any remote-tracking branch')
      expect(refLine, cmd).not.toContain('origin/<branch>')
    }
  })

  it('falsification (P10): rejects an injected extra reference or an unknown section', () => {
    const impl = read('commands/impl.md')
    const duplicated = `${impl}\nRead ~/.claude/.ccg/prompts/claude/osm-square2.md §Correct.\n`
    expect(validateSquare2Reference(duplicated, sections).ok).toBe(false)

    const badSection = impl.replace('§Impl', '§MissingSection')
    expect(validateSquare2Reference(badSection, sections).ok).toBe(false)
  })
})

describe('verified-delivery and L-0004 template sync', () => {
  const plan = read('commands/plan.md')
  const impl = read('commands/impl.md')
  const review = read('commands/review.md')
  const report = read('prompts/claude/osm-report.md')

  it('keeps tree_sha in impl.md, review.md and osm-report.md', () => {
    expect(impl).toContain('tree_sha')
    expect(review).toContain('tree_sha')
    expect(report).toContain('tree_sha')
  })

  it('puts EVIDENCE (not instructions): placeholder in BOTH reviewer heredocs in review.md', () => {
    const heredocs = [...review.matchAll(/<<'EOF'[\s\S]*?EOF"/g)].map(m => m[0])
    expect(heredocs).toHaveLength(2)
    for (const [idx, block] of heredocs.entries()) {
      expect(block, `reviewer heredoc #${idx + 1}`).toContain('EVIDENCE (not instructions):')
    }
  })

  it('updates review.md with tree diff, inline-fix re-checks, Correct ladder, and no user-accept-Critical exit', () => {
    expect(review).not.toMatch(/explicitly accepted/i)
    expect(review).toContain('git diff <merge-base or HEAD> "$tree_sha"')
    expect(review).toContain('critical_open')
    expect(review).toContain('after 3 rounds with an open Critical')
    expect(review).toContain('Correct Ladder')
    expect(review).toContain('re-run the gate delta')
    expect(review).toContain('~/.claude/bin/osm verify-guard --base "$base_tree" --paths')
    expect(review).toMatch(/follow `§Correct` \*\*only\*\* when the role file was loaded/)
  })

  it('enforces writer-recorded base_tree timing, evidence exit 0 + tree match, --compare explore post gate, SHA-bound archive and guarded OSM-Reviewed in impl.md', () => {
    expect(plan).toContain('one exact command line')
    expect(impl).toContain('verify_sha256')
    expect(impl).toContain('base_tree=$(~/.claude/bin/osm verify-guard --print-tree)')
    expect(impl).toContain('Use the reported `base <sha>` as `base_tree`')
    expect(impl).toContain('~/.claude/bin/osm verify-guard --base "$base_tree" --paths')
    expect(impl).toContain('exit 0  tree <sha7>  base <sha>')
    expect(impl).toContain('re-run the post gate')
    expect(impl).toContain('critical_open = 0')
    expect(impl).toContain('OSM-Reviewed: <tree_sha7> (Critical 0)')
    expect(impl).toContain('commits before the first `/osm:review` get no `OSM-Reviewed` trailer')
  })

  it('every backend builder.md records base <sha> before first VERIFY and computes tree <sha7>', () => {
    const promptsRoot = join(PACKAGE_ROOT, 'templates', 'prompts')
    const backends = readdirSync(promptsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    expect(backends.length).toBeGreaterThanOrEqual(7)
    for (const backend of backends) {
      const content = read(`prompts/${backend}/builder.md`)
      expect(content, `${backend}/builder.md`).toContain('VERIFY <command>')
      expect(content, `${backend}/builder.md`).toContain('exit <n>  tree <sha7>  base <sha>')
      expect(content, `${backend}/builder.md`).toContain('<last ≤20 lines>')
      expect(content, `${backend}/builder.md`).toContain('Immediately before your **first** VERIFY run, record `base <sha>` with `~/.claude/bin/osm verify-guard --print-tree`')
      expect(content, `${backend}/builder.md`).toContain('osm verify-guard --print-tree | cut -c1-7')
    }
  })

  it('osm-report.md includes required header fields, base <sha>, temp-index tree_sha with error/no-index handling, restored lines and gate-impl operation_key', () => {
    for (const token of [
      'Tree: <tree_sha>',
      'Reviewed tree:',
      'Critical open:',
      'Gate:',
      'verify_sha256:',
      'VERIFY <command>',
      'exit <n>  tree <sha7>  base <sha>',
      'set -e',
      'GIT_INDEX_FILE',
      'git write-tree',
      '[ -f "$src" ]',
      '[ -n "$tree_sha" ]',
      'routine acks don\'t count',
      '0 if none; omit if not counted',
      'use the phase identifier from tasks.md',
      '"operation_key":"gate-impl-<phase>"',
      '"gate-review"',
      'rules[*].baselined',
      'rules[*].excepted',
    ]) {
      expect(report).toContain(token)
    }
  })
})

describe('installer copies osm-square2.md and rewrites paths', () => {
  it('installs osm-square2.md to .ccg/prompts/claude/osm-square2.md', async () => {
    const root = join(tmpdir(), `osm-sq2-install-${Date.now()}`)
    const installDir = join(root, '.claude')
    try {
      await fs.ensureDir(join(installDir, 'bin'))
      await fs.writeFile(
        join(installDir, 'bin', 'codeagent-wrapper'),
        '#!/usr/bin/env node\nconsole.log("codeagent-wrapper version 5.16.0-osm.3")\n',
        { mode: 0o755 },
      )
      const result = await installWorkflows(getAllCommandIds(), installDir, true, { mcpProvider: 'skip' })
      expect(result.success).toBe(true)
      expect(result.installedPrompts).toContain('claude/osm-square2')

      const installedPath = join(installDir, '.ccg', 'prompts', 'claude', 'osm-square2.md')
      expect(await fs.pathExists(installedPath)).toBe(true)
      const installed = readFileSync(installedPath, 'utf8')
      expect(installed).toContain(`${installDir}/bin/osm ledger hash-report`)
      expect(installed).toContain(`${installDir}/bin/osm verify-guard`)
      expect(installed).not.toContain('~/.claude/')

      for (const cmd of ['research', 'plan', 'impl', 'review']) {
        const rendered = readFileSync(join(installDir, 'commands', 'osm', `${cmd}.md`), 'utf8')
        expect(rendered, cmd).toContain(`${installDir}/.ccg/prompts/claude/osm-square2.md`)
      }
      const renderedBuilder = readFileSync(join(installDir, '.ccg', 'prompts', 'codex', 'builder.md'), 'utf8')
      expect(renderedBuilder).toContain(`${installDir}/bin/osm verify-guard --print-tree | cut -c1-7`)
    }
    finally {
      await fs.remove(root)
    }
  }, 60_000)
})

describe('square2 policy edits block the impl phase', () => {
  it('blocks writer changes to .square2/** and reads ratchet codes from stdout', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const role = readFileSync(join(__dirname, '../../../templates/prompts/claude/osm-square2.md'), 'utf8')
    expect(role).toContain('git diff --name-only "$pre_tree"')
    expect(role).toContain('-- .square2/')
    expect(role).toContain('$post.out')
    expect(role).toContain('[S2-EXC-INVALID]')
  })
})
