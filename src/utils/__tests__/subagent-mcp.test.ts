/**
 * Regression guard: a sub-agent told to use MCP must be given MCP.
 *
 * Since v3.6.0 the wrapper makes sub-agents skip MCP by default, because a
 * sub-agent that only edits files and runs commands spends ~25s connecting
 * servers it never calls. the removed `/ccg:codex-exec` was built on the
 * opposite premise — its whole point is that the sub-agent does the retrieval
 * so Claude spends no tokens on it — and its payload names ace-tool, context7
 * and grok-search explicitly.
 *
 * The two halves live in different files (a Go wrapper and a Markdown
 * template), so nothing but a test connects them: the default changed under a
 * template that still assumed the old one, and the failure is silent — the
 * sub-agent is simply asked to use tools it cannot see.
 */

import { readFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../installer-template'

/** Every wrapper invocation in a command template, one per line. */
function wrapperCalls(template: string): string[] {
  return readFileSync(join(PACKAGE_ROOT, 'templates', template), 'utf-8')
    .split('\n')
    .filter(line => line.includes('codeagent-wrapper'))
}

/**
 * Lines that are inside a heredoc — i.e. text handed to the sub-agent rather
 * than instructions Claude follows itself.
 *
 * Paired by the opener's own tag: closers here are written `EOF",` inside a
 * JSON-ish Bash({...}) block, so matching a bare `EOF` word is not enough and
 * a stricter pattern silently never closes, swallowing the rest of the file.
 */
function payloadLines(template: string): string[] {
  const lines = readFileSync(join(PACKAGE_ROOT, 'templates', template), 'utf-8').split('\n')
  const payload: string[] = []
  let tag: string | undefined
  for (const line of lines) {
    if (tag === undefined) {
      const opener = line.match(/<<'([A-Z_]+)'/)
      if (opener) tag = opener[1]
      continue
    }
    if (line.trimStart().startsWith(tag)) {
      tag = undefined
      continue
    }
    payload.push(line)
  }
  return payload
}

describe('sub-agents that are told to use MCP get MCP', () => {
  // Every /osm:* worker runs without MCP (the wrapper default). If a payload ever
  // asks the worker for MCP retrieval, its call must opt in with --with-mcp.
  const templates = ['init', 'research', 'plan', 'impl', 'review'].map(name => `commands/${name}.md`)
  it.each(templates)('%s keeps MCP on the Claude side or opts in', (template) => {
    const asksForMcp = payloadLines(template).some(line => /mcp__|\bMCP\b/.test(line))
    if (asksForMcp) expect(wrapperCalls(template).every(line => line.includes('--with-mcp'))).toBe(true)
    else expect(asksForMcp).toBe(false)
  })
})
