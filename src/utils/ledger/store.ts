import type { EventInput, LedgerEvent } from './schema'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'pathe'
import { canonicalJson, sha256Hex } from './canonical'
import { computeHarness } from './harness'
import { PARAMS } from './params'
import { defaultInstallDir, defaultLedgerRoot, disabledMarker, globalLog, projectDir, projectLog } from './paths'
import type { ProjectIdentity } from './project'
import { ProjectInterruptedError, resolveProject } from './project'
import { validateInput, ValidationError } from './schema'

export const EXIT = { ok: 0, invalid: 2, lockTimeout: 3, storage: 4, conflict: 5 } as const

export interface Receipt {
  status: 'appended' | 'duplicate' | 'disabled'
  event_id: string | null
}

export type AppendResult =
  | { code: 0, receipt: Receipt }
  | { code: 2 | 3 | 4 | 5, error: string }

export interface LogContents {
  events: LedgerEvent[]
  invalid: number
}

export class LockTimeoutError extends Error {}

export function ledgerDisabled(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OSM_LEDGER === '0' || existsSync(disabledMarker(root))
}

export function eventId(projectId: string, runId: string, kind: string, operationKey: string): string {
  return sha256Hex([projectId, runId, kind, operationKey].join('\0'), 16)
}

/**
 * Reads every parseable line. A tail missing only its LF is a complete event (appendLine terminates it
 * before writing more), so it counts; any other fragment counts as invalid.
 */
export function readLog(path: string): LogContents {
  if (!existsSync(path)) return { events: [], invalid: 0 }
  const text = readFileSync(path, 'utf8')
  const events: LedgerEvent[] = []
  let invalid = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.event_id === 'string' && Number.isInteger(e.seq)) events.push(e)
      else invalid++
    }
    catch {
      invalid++
    }
  }
  return { events, invalid }
}

export interface LogScan {
  maxSeq: number
  existing: LedgerEvent | null
  stageEvents: LedgerEvent[]
}

function tryParse(line: string): LedgerEvent | null {
  try {
    const e = JSON.parse(line)
    return e && typeof e.event_id === 'string' && Number.isInteger(e.seq) ? e : null
  }
  catch {
    return null
  }
}

/**
 * What one append needs, without parsing every line: seq comes from the last valid line (seq only grows),
 * duplicates are found by their serialized id, and stage events are parsed only for outcome resolution.
 */
export function scanLog(path: string, id: string, withStageEvents: boolean): LogScan {
  if (!existsSync(path)) return { maxSeq: 0, existing: null, stageEvents: [] }
  const text = readFileSync(path, 'utf8')
  let maxSeq = 0
  for (let end = text.length; end > 0;) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const e = tryParse(text.slice(start, end))
    if (e) {
      maxSeq = e.seq
      break
    }
    end = start - 1
  }
  // A torn copy of the same event can come first; keep looking until a match parses.
  let existing: LedgerEvent | null = null
  const pattern = `"event_id":"${id}"`
  for (let at = text.indexOf(pattern); at >= 0 && !existing; at = text.indexOf(pattern, at + 1)) {
    const e = tryParse(text.slice(text.lastIndexOf('\n', at) + 1, (text.indexOf('\n', at) + 1 || text.length + 1) - 1))
    if (e?.event_id === id) existing = e
  }
  const stageEvents: LedgerEvent[] = []
  if (withStageEvents) {
    for (const line of text.split('\n')) {
      if (!line.includes('"kind":"stage_completed"')) continue
      const e = tryParse(line)
      if (e?.kind === 'stage_completed') stageEvents.push(e)
    }
  }
  return { maxSeq, existing, stageEvents }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms)
}

export interface LockInfo {
  path: string
  pid: number | null
  host: string | null
  age_ms: number
}

/** Reports a lock left by an interrupted writer, so the user can remove it (locks are never stolen). */
export function lockInfo(logPath: string, now = Date.now()): LockInfo | null {
  const path = `${logPath}.lock`
  if (!existsSync(path)) return null
  let owner: { pid?: number, host?: string } = {}
  try {
    owner = JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {}
  let age = 0
  try {
    age = now - statSync(path).mtimeMs
  }
  catch {}
  return { path, pid: owner.pid ?? null, host: owner.host ?? null, age_ms: Math.max(0, Math.round(age)) }
}

const RETRYABLE = process.platform === 'win32' ? ['EEXIST', 'EPERM', 'EACCES'] : ['EEXIST']

/** Runs `fn` while holding `<path>.lock`. Never steals a lock, whatever its age. */
export function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`
  const token = randomUUID()
  const deadline = Date.now() + PARAMS.append.lockTimeoutMs
  while (true) {
    let fd: number
    try {
      fd = openSync(lock, 'wx', 0o600)
    }
    catch (error: any) {
      // A failed first write by another process may have removed the empty project dir.
      if (error?.code === 'ENOENT' && Date.now() < deadline) {
        mkdirSync(dirname(lock), { recursive: true, mode: 0o700 })
        continue
      }
      if (!RETRYABLE.includes(error?.code)) throw error
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(`lock busy: ${lock} (if no writer is running, remove it: rm '${lock.replace(/'/g, "'\\''")}')`)
      }
      sleepSync(PARAMS.append.lockRetryMs)
      continue
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token }))
    }
    catch (error) {
      closeSync(fd)
      unlinkSync(lock)
      throw error
    }
    closeSync(fd)
    break
  }
  try {
    return fn()
  }
  finally {
    try {
      if (JSON.parse(readFileSync(lock, 'utf8')).token === token) unlinkSync(lock)
    }
    catch {}
  }
}

function endsWithNewline(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size === 0) return true
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0A
  }
  finally {
    closeSync(fd)
  }
}

/** Appends one line durably: O_APPEND, then fsync. Terminates a torn tail first so the new line stands alone. */
export function appendLine(path: string, line: string): void {
  const prefix = existsSync(path) && !endsWithNewline(path) ? '\n' : ''
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600)
  try {
    const buf = Buffer.from(`${prefix}${line}\n`, 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir)
  }
  catch {}
}

function writeMetaOnce(path: string, name: string, now: Date): void {
  try {
    writeFileSync(path, `${JSON.stringify({ name, created_at: now.toISOString() })}\n`, { flag: 'wx', mode: 0o600 })
  }
  catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
  }
}

function comparable(e: Pick<EventInput, 'payload'> & Record<string, unknown>): string {
  const { seq, recorded_at, event_id, producer, harness, ...rest } = e as Record<string, any>
  const { target_event_id, ...payload } = rest.payload ?? {}
  return canonicalJson({ ...rest, payload })
}

export interface AppendOptions {
  root?: string
  installDir?: string
  projectRoot?: string
  version: string
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Which log receives the event; `global` is only used for promoted lesson entries. */
  log?: 'project' | 'global'
  /** Runs under the same lock after the event is appended or found as a duplicate (e.g. automatic lesson retirement). */
  after?: (ctx: LockedContext, receipt: Receipt) => AppendResult | void
}

/** Everything needed to write further events while the log lock is held. */
export interface LockedContext {
  root: string
  path: string
  project: ProjectIdentity
  installDir: string
  version: string
  now: Date
  meta: string | null
}

/** Appends one validated event; the caller must hold the lock on `ctx.path`. */
export function commitLocked(ctx: LockedContext, input: EventInput): AppendResult {
  const id = eventId(ctx.project.id, input.run_id, input.kind, input.operation_key)
  const { maxSeq, existing, stageEvents } = scanLog(ctx.path, id, input.kind === 'outcome')
  const payload = { ...input.payload }
  if (input.kind === 'outcome') {
    const t = payload.target
    const target = stageEvents
      .filter(e => e.change_id === t.change_id && e.stage === t.stage && (e.phase_id ?? null) === (t.phase_id ?? null))
      .reduce<LedgerEvent | null>((best, e) => (!best || e.seq > best.seq ? e : best), null)
    if (!target) return { code: EXIT.invalid, error: 'event.payload.target: no matching stage_completed event' }
    payload.target_event_id = target.event_id
  }
  const event: LedgerEvent = {
    schema_version: 1,
    event_id: id,
    seq: maxSeq + 1,
    recorded_at: ctx.now.toISOString(),
    project_id: ctx.project.id,
    run_id: input.run_id,
    change_id: input.change_id,
    stage: input.stage,
    phase_id: input.phase_id,
    kind: input.kind,
    operation_key: input.operation_key,
    producer: ctx.version,
    harness: computeHarness(input, ctx.installDir, ctx.version),
    payload,
  }
  if (existing) {
    if (comparable(existing as any) !== comparable(event as any)) return { code: EXIT.conflict, error: `event ${id} already recorded with a different payload` }
    if (ctx.meta) writeMetaOnce(ctx.meta, ctx.project.name, ctx.now)
    return { code: 0, receipt: { status: 'duplicate', event_id: id } }
  }
  const line = JSON.stringify(event)
  if (Buffer.byteLength(line) + 1 > PARAMS.append.maxLineBytes) return { code: EXIT.invalid, error: `event exceeds ${PARAMS.append.maxLineBytes} bytes` }
  appendLine(ctx.path, line)
  if (ctx.meta) writeMetaOnce(ctx.meta, ctx.project.name, ctx.now)
  return { code: 0, receipt: { status: 'appended', event_id: id } }
}

export type ResolveResult = { ok: true, ctx: LockedContext } | { ok: false, result: AppendResult }

/** Resolves the project and target log for a write. */
export function resolveContext(opts: AppendOptions): ResolveResult {
  const root = opts.root ?? defaultLedgerRoot()
  let project: ProjectIdentity
  try {
    project = resolveProject(opts.projectRoot ?? process.cwd())
  }
  catch (error) {
    return { ok: false, result: { code: error instanceof ProjectInterruptedError ? EXIT.storage : EXIT.invalid, error: `project root: ${(error as Error).message}` } }
  }
  const global = opts.log === 'global'
  return {
    ok: true,
    ctx: {
      root,
      path: global ? globalLog(root) : projectLog(root, project.id),
      project,
      installDir: opts.installDir ?? (opts.env ?? process.env).OSM_INSTALL_DIR ?? defaultInstallDir(),
      version: opts.version,
      now: opts.now?.() ?? new Date(),
      meta: global ? null : join(projectDir(root, project.id), 'meta.json'),
    },
  }
}

/** Runs `fn` under the lock of `ctx.path`, creating its directory and removing it again if nothing was written. */
export function underLock(ctx: LockedContext, fn: () => AppendResult): AppendResult {
  const dir = dirname(ctx.path)
  const created = !existsSync(dir)
  try {
    ensureDir(dir)
    const result = withLock(ctx.path, fn)
    if (created && result.code !== 0) removeIfEmpty(dir)
    return result
  }
  catch (error) {
    if (created) removeIfEmpty(dir)
    if (error instanceof LockTimeoutError) return { code: EXIT.lockTimeout, error: error.message }
    return { code: EXIT.storage, error: (error as Error).message }
  }
}

export function appendEvent(raw: unknown, opts: AppendOptions): AppendResult {
  const root = opts.root ?? defaultLedgerRoot()
  if (ledgerDisabled(root, opts.env)) return { code: 0, receipt: { status: 'disabled', event_id: null } }

  let input: EventInput
  try {
    input = validateInput(raw)
  }
  catch (error) {
    if (error instanceof ValidationError) return { code: EXIT.invalid, error: error.message }
    throw error
  }

  // Lesson state changes only through `osm ledger lessons`, which enforces the lifecycle gates (spec: evidence-lessons).
  if (input.kind === 'lesson_state') return { code: EXIT.invalid, error: 'lesson_state events are written only by `osm ledger lessons`' }
  const resolved = resolveContext(opts)
  if (!resolved.ok) return resolved.result
  const { ctx } = resolved
  return underLock(ctx, () => {
    const result = commitLocked(ctx, input)
    if (result.code !== 0 || !opts.after) return result
    return opts.after(ctx, result.receipt) ?? result
  })
}
