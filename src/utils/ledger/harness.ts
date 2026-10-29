import type { EventInput, Harness, Invocation } from './schema'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import { canonicalJson, sha256Hex } from './canonical'
import { PARAMS } from './params'

export function paramsHash(): string {
  return sha256Hex(canonicalJson(PARAMS), 12)
}

function fileHash(installDir: string, rel: string): string | null {
  try {
    return sha256Hex(readFileSync(join(installDir, rel)), 12)
  }
  catch {
    return null
  }
}

/** The installed OpenSlime files an event's stage used. */
export function harnessFiles(input: Pick<EventInput, 'stage' | 'kind' | 'payload'>): string[] {
  if (input.stage === 'lesson') return []
  const files = new Set([`commands/osm/${input.stage}.md`, '.ccg/prompts/claude/osm-report.md'])
  if (input.kind === 'stage_completed') {
    for (const inv of input.payload.invocations as Invocation[]) files.add(`.ccg/prompts/${inv.backend}/${inv.role}.md`)
  }
  return [...files].sort()
}

function markdownIn(installDir: string, rel: string): string[] {
  try {
    return readdirSync(join(installDir, rel)).filter(f => f.endsWith('.md')).map(f => `${rel}/${f}`)
  }
  catch {
    return []
  }
}

/** Every installed OpenSlime command template and role prompt, so any change to OpenSlime itself starts a new cohort. */
export function installFiles(installDir: string): string[] {
  let backends: string[] = []
  try {
    backends = readdirSync(join(installDir, '.ccg', 'prompts'))
  }
  catch {}
  return [
    ...markdownIn(installDir, 'commands/osm'),
    ...backends.flatMap(b => markdownIn(installDir, `.ccg/prompts/${b}`)),
  ].sort()
}

export function harnessDigest(files: Record<string, string | null>, params: string): string {
  return sha256Hex(canonicalJson({ files, params }), 16)
}

export function computeHarness(input: Pick<EventInput, 'stage' | 'kind' | 'payload'>, installDir: string, version: string): Harness {
  const files: Record<string, string | null> = {}
  for (const rel of harnessFiles(input)) files[rel] = fileHash(installDir, rel)
  const params = paramsHash()
  const all: Record<string, string | null> = {}
  for (const rel of installFiles(installDir)) all[rel] = fileHash(installDir, rel)
  return { version, digest: harnessDigest(files, params), install: harnessDigest(all, params), files, params }
}

/** The install digest of what is installed now, as a new event would record it. */
export function currentInstall(installDir: string): string {
  const all: Record<string, string | null> = {}
  for (const rel of installFiles(installDir)) all[rel] = fileHash(installDir, rel)
  return harnessDigest(all, paramsHash())
}
