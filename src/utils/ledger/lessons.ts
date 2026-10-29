import type { EventInput, LedgerEvent } from './schema'
import type { AppendResult, LockedContext } from './store'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { PARAMS } from './params'
import { globalLog, projectDir } from './paths'
import type { Tally } from './probe'
import { firstInertCount, isCredited, lessonTally, lossWeight, meetsAdoptionBar, probeResult, retireReason } from './probe'
import { containsAbsolutePath, validateInput, ValidationError } from './schema'
import type { AppendOptions } from './store'
import { commitLocked, EXIT, readLog, resolveContext, underLock, withLock } from './store'

export type Scope = 'project' | 'global'
export type LessonState = 'candidate' | 'trial' | 'adopted' | 'retired'

export interface Lesson {
  id: string
  scope: Scope
  state: LessonState
  slot: 'brief'
  line: string
  cue: string
  match: { globs: string[], kind: 'backend' | 'frontend' | 'any', keywords: string[] }
  evidence: string[]
  contradicts: string[]
  created_from: string
  promoted_from: string | null
  revision: number
  body: string
}

const FRONT_KEYS = ['id', 'scope', 'state', 'slot', 'line', 'cue', 'match', 'evidence', 'contradicts', 'created_from', 'promoted_from', 'revision'] as const

export function lessonsDir(root: string, scope: Scope, projectId: string): string {
  return scope === 'project' ? join(projectDir(root, projectId), 'lessons') : join(root, 'global', 'lessons')
}

/** Front matter is one `key: <JSON>` line per field; JSON values are valid YAML flow scalars. */
export function serializeLesson(l: Lesson): string {
  const front = FRONT_KEYS.map(k => `${k}: ${JSON.stringify(l[k])}`).join('\n')
  return `---\n${front}\n---\n${l.body ? `${l.body.replace(/\n*$/, '')}\n` : ''}`
}

export function parseLesson(text: string): Lesson | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  const out: Record<string, unknown> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+): (.*)$/.exec(line)
    if (!kv) return null
    try {
      out[kv[1]] = JSON.parse(kv[2])
    }
    catch {
      return null
    }
  }
  if (!FRONT_KEYS.every(k => k in out)) return null
  return { ...(out as unknown as Lesson), body: m[2].replace(/\n$/, '') }
}

export function readLessons(dir: string): Lesson[] {
  const entries = join(dir, 'entries')
  let names: string[] = []
  try {
    names = readdirSync(entries).filter(n => /^L-\d{4,}\.md$/.test(n)).sort()
  }
  catch {}
  return names.map(n => parseLesson(readFileSync(join(entries, n), 'utf8'))).filter((l): l is Lesson => l !== null)
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

function writeLesson(dir: string, l: Lesson): void {
  mkdirSync(join(dir, 'entries'), { recursive: true, mode: 0o700 })
  writeAtomic(join(dir, 'entries', `${l.id}.md`), serializeLesson(l))
}

/** From file names, not parsed entries, so an unparseable entry's id is never issued again. */
function nextId(dir: string): string {
  let names: string[] = []
  try {
    names = readdirSync(join(dir, 'entries'))
  }
  catch {}
  const max = names.reduce((m, n) => {
    const mm = /^L-(\d{4,})\.md$/.exec(n)
    return mm ? Math.max(m, Number(mm[1])) : m
  }, 0)
  return `L-${String(max + 1).padStart(4, '0')}`
}

function cut(s: string, max: number): string {
  const cps = [...s]
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function indexLine(l: Lesson, state: LessonState, t?: Tally): string {
  const tally = t ? ` · W${t.W} L${t.L} T${t.T}` : ''
  return cut(`${l.id} ${state} ${l.scope} "${oneLine(l.line)}" cue: ${oneLine(l.cue)}${tally}`, PARAMS.lessons.indexLineMax)
}

/** INDEX.md is derived from entry files and never authoritative. */
export function rebuildIndex(dir: string, states: (l: Lesson) => LessonState = l => l.state): void {
  const lines = readLessons(dir).map(l => ({ l, s: states(l) })).filter(x => x.s !== 'retired').map(x => indexLine(x.l, x.s))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeAtomic(join(dir, 'INDEX.md'), `${lines.join('\n')}${lines.length ? '\n' : ''}`)
}

/** A lesson's state in this project: the last local `lesson_state`, else trial for a global lesson. */
export function effectiveState(events: LedgerEvent[], scope: Scope, id: string, fallback: LessonState | null): LessonState | null {
  let state: LessonState | null = null
  let seq = -1
  for (const e of events) {
    if (e.kind === 'lesson_state' && e.payload.scope === scope && e.payload.lesson_id === id && e.seq > seq) {
      state = e.payload.to
      seq = e.seq
    }
  }
  // The entry file is only a cache: a project lesson with no events (e.g. hand-made) is never more than a candidate.
  return state ?? (scope === 'global' ? (fallback === 'retired' ? 'retired' : 'trial') : fallback === null ? null : fallback === 'retired' ? 'retired' : 'candidate')
}

const EMPTY_TALLY: Tally = { W: 0, L: 0, T: 0, inert: 0, void: 0, changes_with_wins: 0, severe_losses: 0, decisive: 0, total: 0 }

export interface LessonFold {
  state: Map<string, LessonState>
  tally: Map<string, Tally>
}

/** One pass over the log: every lesson's latest local state and its tally, keyed `scope/id`. */
export function foldLessons(events: LedgerEvent[]): LessonFold {
  const state = new Map<string, LessonState>()
  const tally = new Map<string, Tally>()
  const changes = new Map<string, Set<string>>()
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind === 'lesson_state') {
      state.set(`${e.payload.scope}/${e.payload.lesson_id}`, e.payload.to)
      continue
    }
    if (e.kind !== 'probe' || e.payload.mode !== 'lesson' || !e.payload.lesson_id) continue
    const r = probeResult(e.payload as any)
    if (r === 'skipped') continue
    const key = `${e.payload.lesson_scope}/${e.payload.lesson_id}`
    const t = tally.get(key) ?? { ...EMPTY_TALLY }
    tally.set(key, t)
    t.total++
    if (r === 'win') {
      t.W++
      t.decisive++
      if (e.change_id) {
        const c = changes.get(key) ?? new Set()
        c.add(e.change_id)
        changes.set(key, c)
        t.changes_with_wins = c.size
      }
    }
    else if (isCredited(r) && r !== 'tie') {
      t.L += lossWeight(r)
      t.decisive++
      if (r === 'severe_loss') t.severe_losses++
    }
    else if (r === 'tie') t.T++
    else if (r === 'inert') t.inert++
    else if (r === 'void') t.void++
  }
  return { state, tally }
}

function foldState(f: LessonFold, scope: Scope, id: string, fallback: LessonState): LessonState {
  return f.state.get(`${scope}/${id}`) ?? (fallback === 'retired' ? 'retired' : scope === 'global' ? 'trial' : 'candidate')
}

function transitionCount(events: LedgerEvent[], scope: Scope, id: string): number {
  return events.filter(e => e.kind === 'lesson_state' && e.payload.scope === scope && e.payload.lesson_id === id).length
}

function stateEvent(runId: string, scope: Scope, id: string, from: LessonState | null, to: LessonState, reason: string, t: Tally, n: number): EventInput {
  const { decisive, total, ...tally } = t
  return validateInput({
    schema_version: 1,
    run_id: runId,
    change_id: null,
    stage: 'lesson',
    phase_id: null,
    kind: 'lesson_state',
    operation_key: `${scope}:${id}:${n}:${from ?? 'new'}->${to}`,
    payload: { lesson_id: id, scope, from, to, reason: cut(reason, PARAMS.append.maxText), tally },
  })
}


export interface LessonResult {
  code: number
  message: string
  data?: Record<string, unknown>
}

function fromAppend(r: AppendResult): LessonResult | null {
  return r.code === 0 ? null : { code: r.code, message: (r as { error: string }).error }
}

function fail(code: number, message: string): LessonResult {
  return { code, message }
}

function lockedLessons(opts: AppendOptions, fn: (ctx: LockedContext, events: LedgerEvent[]) => LessonResult): LessonResult {
  const resolved = resolveContext({ ...opts, log: 'project' })
  if (!resolved.ok) return fail(resolved.result.code, (resolved.result as { error: string }).error)
  let out: LessonResult = fail(EXIT.storage, 'not run')
  const r = underLock(resolved.ctx, () => {
    try {
      out = fn(resolved.ctx, readLog(resolved.ctx.path).events)
    }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error
      out = fail(EXIT.invalid, error.message)
    }
    return out.code === 0 ? { code: 0, receipt: { status: 'appended', event_id: null } } : { code: out.code as 2, error: out.message }
  })
  return r.code === 0 ? out : fail(r.code, (r as { error: string }).error)
}

function eventIdsIn(root: string, ctx: LockedContext): Set<string> {
  return new Set([...readLog(ctx.path).events, ...readLog(globalLog(root)).events].map(e => e.event_id))
}

export interface AddInput {
  line: string
  cue: string
  match: Lesson['match']
  evidence: string[]
  created_from: string
  contradicts?: string[]
  body?: string
}

function validateAdd(raw: unknown): AddInput {
  const o = raw as Record<string, any>
  const allowed = ['line', 'cue', 'match', 'evidence', 'created_from', 'contradicts', 'body']
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ValidationError('lesson: expected object')
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ValidationError(`lesson.${k}: unknown field`)
  const noPath = (v: string, k: string) => {
    if (containsAbsolutePath(v)) throw new ValidationError(`lesson.${k}: must not contain an absolute path`)
    return v
  }
  const text = (v: unknown, k: string, max: number) => {
    if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`lesson.${k}: expected non-empty string`)
    if ([...v].length > max) throw new ValidationError(`lesson.${k}: longer than ${max} code points`)
    return noPath(v, k)
  }
  const line = text(o.line, 'line', PARAMS.lessons.lineMax)
  if (/[\r\n]/.test(line)) throw new ValidationError('lesson.line: must be a single line')
  text(o.cue, 'cue', PARAMS.lessons.cueMax)
  text(o.created_from, 'created_from', 200)
  const strings = (v: unknown, k: string, min: number) => {
    if (!Array.isArray(v) || v.length < min || v.length > PARAMS.append.maxArray || v.some(x => typeof x !== 'string' || !x)) {
      throw new ValidationError(`lesson.${k}: expected ${min}..${PARAMS.append.maxArray} non-empty strings`)
    }
    for (const x of v as string[]) noPath(x, k)
    return v as string[]
  }
  strings(o.evidence, 'evidence', 1)
  if (o.contradicts !== undefined) strings(o.contradicts, 'contradicts', 0)
  const m = o.match
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some(k => !['globs', 'kind', 'keywords'].includes(k))) throw new ValidationError('lesson.match: expected { globs, kind, keywords }')
  strings(m.globs, 'match.globs', 0)
  for (const g of m.globs as string[]) {
    if (!safeGlob(g)) throw new ValidationError(`lesson.match.globs: "${cut(g, 40)}" is too complex (≤200 chars, ≤1 brace group, ≤4 wildcards)`)
  }
  strings(m.keywords, 'match.keywords', 0)
  if (!['backend', 'frontend', 'any'].includes(m.kind)) throw new ValidationError('lesson.match.kind: expected backend|frontend|any')
  if (o.body !== undefined && (typeof o.body !== 'string' || Buffer.byteLength(o.body) > PARAMS.lessons.bodyMaxBytes)) {
    throw new ValidationError(`lesson.body: at most ${PARAMS.lessons.bodyMaxBytes} bytes`)
  }
  if (typeof o.body === 'string') noPath(o.body, 'body')
  return o as AddInput
}

/** Non-retired lessons by line, across both scopes. */
function activeByLine(root: string, projectId: string, fold: LessonFold): Map<string, Array<{ lesson: Lesson, state: LessonState }>> {
  const out = new Map<string, Array<{ lesson: Lesson, state: LessonState }>>()
  for (const scope of ['project', 'global'] as const) {
    for (const l of readLessons(lessonsDir(root, scope, projectId))) {
      const state = foldState(fold, scope, l.id, l.state)
      if (state === 'retired') continue
      const list = out.get(l.line) ?? []
      list.push({ lesson: l, state })
      out.set(l.line, list)
    }
  }
  return out
}

/** Promotes the lowest-id candidate that shares a line with no other active lesson; used after a retirement and to resume a crashed add. */
function relint(ctx: LockedContext, runId: string, line: string): void {
  const events = readLog(ctx.path).events
  const fold = foldLessons(events)
  const same = activeByLine(ctx.root, ctx.project.id, fold).get(line) ?? []
  if (same.some(x => x.state !== 'candidate')) return
  const next = same.filter(x => x.lesson.scope === 'project').sort((a, b) => Number(a.lesson.id.slice(2)) - Number(b.lesson.id.slice(2)))[0]
  if (!next) return
  const r = commitLocked(ctx, stateEvent(runId, 'project', next.lesson.id, 'candidate', 'trial', 'passed lint', EMPTY_TALLY, transitionCount(events, 'project', next.lesson.id)))
  if (r.code === 0) writeLesson(lessonsDir(ctx.root, 'project', ctx.project.id), { ...next.lesson, state: 'trial' })
}

export function addLesson(raw: unknown, opts: AppendOptions & { runId: string }): LessonResult {
  let input: AddInput
  try {
    input = validateAdd(raw)
  }
  catch (error) {
    if (error instanceof ValidationError) return fail(EXIT.invalid, error.message)
    throw error
  }
  return lockedLessons(opts, (ctx, events) => {
    const root = ctx.root
    const known = eventIdsIn(root, ctx)
    const missing = input.evidence.filter(id => !known.has(id))
    if (missing.length) return fail(EXIT.invalid, `lesson.evidence: unknown event ids ${missing.join(', ')}`)
    const fold = foldLessons(events)
    const same = activeByLine(root, ctx.project.id, fold).get(input.line) ?? []
    const dir = lessonsDir(root, 'project', ctx.project.id)
    // A crashed add leaves a lone candidate with this line: resume it instead of minting a duplicate.
    // Only an entry that has its creation event is a crashed add; a hand-made entry without events is not resumed.
    const lone = same.length === 1 && same[0].state === 'candidate' && same[0].lesson.scope === 'project' && transitionCount(events, 'project', same[0].lesson.id) > 0 ? same[0].lesson : null
    // Crashed after the trial event but before the entry was rewritten: the fold says trial, the entry candidate.
    const stale = same.length === 1 && same[0].state === 'trial' && same[0].lesson.scope === 'project' && same[0].lesson.state === 'candidate' ? same[0].lesson : null
    if (stale) {
      writeLesson(dir, { ...stale, state: 'trial' })
      rebuildIndex(dir, l => foldState(fold, 'project', l.id, l.state))
      return { code: 0, message: `${stale.id} trial (resumed)`, data: { id: stale.id, state: 'trial' } }
    }
    if (lone) {
      relint(ctx, opts.runId, input.line)
      rebuildIndex(dir, l => foldState(foldLessons(readLog(ctx.path).events), 'project', l.id, l.state))
      return { code: 0, message: `${lone.id} trial (resumed)`, data: { id: lone.id, state: 'trial' } }
    }
    const duplicate = same.length > 0
    const id = nextId(dir)
    const lesson: Lesson = {
      id,
      scope: 'project',
      state: 'candidate',
      slot: 'brief',
      line: input.line,
      cue: input.cue,
      match: input.match,
      evidence: input.evidence,
      contradicts: input.contradicts ?? [],
      created_from: input.created_from,
      promoted_from: null,
      revision: 1,
      body: input.body ?? '',
    }
    const added = commitLocked(ctx, stateEvent(opts.runId, 'project', id, null, 'candidate', `added from ${input.created_from}`, EMPTY_TALLY, 0))
    const err = fromAppend(added)
    if (err) return err
    writeLesson(dir, lesson)
    if (!duplicate) {
      const trial = commitLocked(ctx, stateEvent(opts.runId, 'project', id, 'candidate', 'trial', 'passed lint', EMPTY_TALLY, 1))
      const err2 = fromAppend(trial)
      if (err2) return err2
      lesson.state = 'trial'
      writeLesson(dir, lesson)
    }
    const after = foldLessons(readLog(ctx.path).events)
    rebuildIndex(dir, l => foldState(after, 'project', l.id, l.state))
    return { code: 0, message: `${id} ${lesson.state}${duplicate ? ' (same line as an active lesson; stays candidate)' : ''}`, data: { id, state: lesson.state } }
  })
}

function findLesson(root: string, projectId: string, scope: Scope, id: string): Lesson | null {
  return readLessons(lessonsDir(root, scope, projectId)).find(l => l.id === id) ?? null
}

/** The reveal question's decision id; global lessons carry their scope so one answer cannot adopt the other L-NNNN. */
export function revealDecisionId(scope: Scope, id: string): string {
  return scope === 'global' ? `reveal-global-${id}` : `reveal-${id}`
}

function findDecision(events: LedgerEvent[], eventId: string, decisionId: string, choice: string): string | null {
  const d = events.find(e => e.event_id === eventId)
  if (!d || d.kind !== 'human_decision') return `--decision ${eventId}: no such human_decision event`
  if (d.payload.decision_id !== decisionId) return `--decision ${eventId}: decision_id must be ${decisionId}`
  if (d.payload.blind) return `--decision ${eventId}: a blind pick cannot adopt; record the reveal decision`
  if (d.payload.final_choice !== choice) return `--decision ${eventId}: final_choice is ${d.payload.final_choice}, not ${choice}`
  return null
}

function syncCache(root: string, projectId: string, scope: Scope, id: string, state: LessonState, events: LedgerEvent[]): void {
  const dir = lessonsDir(root, 'project', projectId)
  if (scope === 'project') {
    const l = findLesson(root, projectId, 'project', id)
    if (l && l.state !== state) writeLesson(dir, { ...l, state })
  }
  const fold = foldLessons(events)
  rebuildIndex(dir, l => foldState(fold, 'project', l.id, l.state))
}

export function adoptLesson(id: string, scope: Scope, decisionEventId: string, opts: AppendOptions & { runId: string }): LessonResult {
  return lockedLessons(opts, (ctx, events) => {
    const lesson = findLesson(ctx.root, ctx.project.id, scope, id)
    if (!lesson) return fail(EXIT.invalid, `${scope} lesson ${id} not found`)
    const state = effectiveState(events, scope, id, lesson.state)
    if (state === 'adopted') {
      syncCache(ctx.root, ctx.project.id, scope, id, 'adopted', events)
      return { code: 0, message: `${id} already adopted` }
    }
    if (state !== 'trial') return fail(EXIT.invalid, `${id} is ${state}; only a trial lesson can be adopted`)
    const bad = findDecision(events, decisionEventId, revealDecisionId(scope, id), 'adopt')
    if (bad) return fail(EXIT.invalid, bad)
    const t = lessonTally(events, scope, id)
    if (!meetsAdoptionBar(t, scope)) return fail(EXIT.invalid, `${id} below the adoption bar: W${t.W} L${t.L} changes_with_wins ${t.changes_with_wins} severe ${t.severe_losses}`)
    const err = fromAppend(commitLocked(ctx, stateEvent(opts.runId, scope, id, 'trial', 'adopted', `reveal decision ${decisionEventId}`, t, transitionCount(events, scope, id))))
    if (err) return err
    syncCache(ctx.root, ctx.project.id, scope, id, 'adopted', readLog(ctx.path).events)
    return { code: 0, message: `${id} adopted`, data: { id, state: 'adopted' } }
  })
}

export function retireLesson(id: string, scope: Scope, reason: string, opts: AppendOptions & { runId: string }): LessonResult {
  if (!reason.trim()) return fail(EXIT.invalid, '--reason is required')
  if (containsAbsolutePath(reason)) return fail(EXIT.invalid, '--reason must not contain an absolute path')
  return lockedLessons(opts, (ctx, events) => {
    const lesson = findLesson(ctx.root, ctx.project.id, scope, id)
    if (!lesson) return fail(EXIT.invalid, `${scope} lesson ${id} not found`)
    const state = effectiveState(events, scope, id, lesson.state)
    if (state === 'retired') {
      syncCache(ctx.root, ctx.project.id, scope, id, 'retired', events)
      return { code: 0, message: `${id} already retired` }
    }
    const t = lessonTally(events, scope, id)
    const err = fromAppend(commitLocked(ctx, stateEvent(opts.runId, scope, id, state, 'retired', reason, t, transitionCount(events, scope, id))))
    if (err) return err
    relint(ctx, opts.runId, lesson.line)
    syncCache(ctx.root, ctx.project.id, scope, id, 'retired', readLog(ctx.path).events)
    return { code: 0, message: `${id} retired`, data: { id, state: 'retired' } }
  })
}

export function promoteLesson(id: string, decisionEventId: string, opts: AppendOptions & { runId: string }): LessonResult {
  return lockedLessons(opts, (ctx, events) => {
    const lesson = findLesson(ctx.root, ctx.project.id, 'project', id)
    if (!lesson) return fail(EXIT.invalid, `project lesson ${id} not found`)
    if (effectiveState(events, 'project', id, lesson.state) !== 'adopted') return fail(EXIT.invalid, `${id} must be adopted in this project before promotion`)
    const bad = findDecision(events, decisionEventId, `promote-${id}`, 'promote')
    if (bad) return fail(EXIT.invalid, bad)
    const source = `${ctx.project.id}/${id}`
    const gdir = lessonsDir(ctx.root, 'global', ctx.project.id)
    const gctx: LockedContext = { ...ctx, path: globalLog(ctx.root), meta: null }
    mkdirSync(join(ctx.root, 'global'), { recursive: true, mode: 0o700 })
    return withLock(gctx.path, (): LessonResult => {
      // Idempotent and crash-safe: reuse an entry and/or creation event that already cite this source,
      // write whichever of the two is missing, and only then report success.
      const entry = readLessons(gdir).find(l => l.promoted_from === source)
      const prior = readLog(gctx.path).events.find(e => e.kind === 'lesson_state' && e.payload.from === null && e.payload.reason === `promoted from ${source}`)
      if (entry && prior) {
        rebuildIndex(gdir)
        return { code: 0, message: `${id} already promoted as global ${entry.id}`, data: { id: entry.id } }
      }
      const gid = entry?.id ?? prior?.payload.lesson_id ?? nextId(gdir)
      if (!entry) writeLesson(gdir, { ...lesson, id: gid, scope: 'global', state: 'trial', promoted_from: source, revision: 1 })
      if (!prior) {
        const err = fromAppend(commitLocked(gctx, stateEvent(opts.runId, 'global', gid, null, 'trial', `promoted from ${source}`, EMPTY_TALLY, 0)))
        if (err) return err
      }
      rebuildIndex(gdir)
      return { code: 0, message: `${id} promoted as global ${gid}`, data: { id: gid } }
    })
  })
}

/** After a lesson probe is recorded: retire the lesson if its tally meets a retirement condition. Runs under the project lock. */
export function autoRetire(ctx: LockedContext, input: EventInput, runId: string): AppendResult | void {
  if (input.kind !== 'probe' || input.payload.mode !== 'lesson' || input.payload.skip_reason !== null || !input.payload.lesson_id) return
  const scope = input.payload.lesson_scope as Scope
  const id = input.payload.lesson_id as string
  const events = readLog(ctx.path).events
  const lesson = findLesson(ctx.root, ctx.project.id, scope, id)
  if (!lesson || effectiveState(events, scope, id, lesson.state) !== 'trial') return
  const t = lessonTally(events, scope, id)
  const reason = retireReason(t, firstInertCount(events, scope, id))
  if (!reason) return
  const r = commitLocked(ctx, stateEvent(runId, scope, id, 'trial', 'retired', reason, t, transitionCount(events, scope, id)))
  if (r.code !== 0) return r
  relint(ctx, runId, lesson.line)
  syncCache(ctx.root, ctx.project.id, scope, id, 'retired', readLog(ctx.path).events)
}

/** Globs are compiled to regexes; bound their shape so a lesson cannot make every query backtrack for seconds. */
export function safeGlob(glob: string): boolean {
  return glob.length <= 200 && (glob.match(/\{/g) ?? []).length <= 1 && (glob.match(/[*?]/g) ?? []).length <= 4
}

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?'
        i++
      }
      else {
        re += '.*'
      }
    }
    else if (c === '*') {
      re += '[^/]*'
    }
    else if (c === '?') {
      re += '[^/]'
    }
    else if (c === '{') {
      const close = glob.indexOf('}', i)
      // Nested braces are not supported: treat the `{` literally rather than mis-splitting.
      if (close < 0 || glob.slice(i + 1, close).includes('{')) {
        re += '\\{'
        continue
      }
      re += `(?:${glob.slice(i + 1, close).split(',').map(alt => globToRegExp(alt).source.slice(1, -1)).join('|')})`
      i = close
    }
    else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

export interface QueryOptions {
  files: string[]
  kind: 'backend' | 'frontend' | 'any'
  text: string
  scope: 'project' | 'global' | 'both'
  limit: number
  all: boolean
}

export interface QueryRow {
  lesson: Lesson
  state: LessonState
  tally: Tally
  conflict: boolean
}

function matches(l: Lesson, q: QueryOptions): boolean {
  const regs = l.match.globs.filter(safeGlob).map(globToRegExp)
  const byFile = q.files.some(f => regs.some(r => r.test(f)))
  const byKind = l.match.kind === 'any' || l.match.kind === q.kind
  const text = q.text.toLowerCase()
  const byKeyword = l.match.keywords.some(k => text.includes(k.toLowerCase()))
  return byFile || byKind || byKeyword
}

const STATE_ORDER: Record<LessonState, number> = { adopted: 0, trial: 1, candidate: 2, retired: 3 }

/** Matching lessons, scanned from entry files (never from INDEX), ordered and bounded. */
export function queryLessons(root: string, projectId: string, events: LedgerEvent[], q: QueryOptions): { rows: QueryRow[], matched: number } {
  const scopes: Scope[] = q.scope === 'both' ? ['project', 'global'] : [q.scope]
  const fold = foldLessons(events)
  const rows: QueryRow[] = []
  for (const scope of scopes) {
    for (const l of readLessons(lessonsDir(root, scope, projectId))) {
      const state = foldState(fold, scope, l.id, l.state)
      if (!q.all && (state === 'candidate' || state === 'retired')) continue
      if (!matches(l, q)) continue
      rows.push({ lesson: l, state, tally: fold.tally.get(`${scope}/${l.id}`) ?? { ...EMPTY_TALLY }, conflict: false })
    }
  }
  const norm = (s: string) => oneLine(s).toLowerCase()
  for (const a of rows) {
    if (a.lesson.scope !== 'project') continue
    for (const b of rows) {
      if (b.lesson.scope === 'global' && norm(a.lesson.cue) === norm(b.lesson.cue) && a.lesson.line !== b.lesson.line) {
        a.conflict = true
        b.conflict = true
      }
    }
  }
  rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (a.lesson.scope === b.lesson.scope ? 0 : a.lesson.scope === 'project' ? -1 : 1)
    || a.tally.decisive - b.tally.decisive
    || Number(a.lesson.id.slice(2)) - Number(b.lesson.id.slice(2)))
  // Keep each conflict partner right after the first-ranked row of its pair, so both are shown together.
  const ordered: QueryRow[] = []
  const groupStart: number[] = []
  const placed = new Set<QueryRow>()
  for (const r of rows) {
    if (placed.has(r)) continue
    const start = ordered.length
    ordered.push(r)
    groupStart.push(start)
    placed.add(r)
    if (!r.conflict) continue
    for (const p of rows) {
      if (!placed.has(p) && p.conflict && p.lesson.scope !== r.lesson.scope && norm(p.lesson.cue) === norm(r.lesson.cue)) {
        ordered.push(p)
        groupStart.push(start)
        placed.add(p)
      }
    }
  }
  // Never split a conflict pair at the limit: move the pair to the next page instead (the bound still holds).
  let end = q.limit
  if (end < ordered.length && groupStart[end] === groupStart[end - 1] && groupStart[end] > 0) end = groupStart[end]
  return { rows: ordered.slice(0, end), matched: rows.length }
}

export function queryLine(r: QueryRow): string {
  const base = indexLine(r.lesson, r.state, r.state === 'trial' ? r.tally : undefined)
  return r.conflict ? cut(`${base} · conflict`, PARAMS.lessons.indexLineMax) : base
}

export function showLesson(l: Lesson, state: LessonState, t: Tally): string[] {
  const lines = [
    `${l.id} · ${l.scope} · ${state} · slot ${l.slot} · revision ${l.revision}`,
    `line: ${l.line}`,
    `cue: ${l.cue}`,
    `match: globs ${JSON.stringify(l.match.globs)} · kind ${l.match.kind} · keywords ${JSON.stringify(l.match.keywords)}`,
    `tally: W${t.W} L${t.L} T${t.T} · inert ${t.inert} · void ${t.void} · decisive ${t.decisive}/${t.total} · wins from ${t.changes_with_wins} changes · severe ${t.severe_losses}`,
    `evidence: ${l.evidence.join(', ')}${l.contradicts.length ? ` · contradicts: ${l.contradicts.join(', ')}` : ''}`,
    `from: ${l.created_from}${l.promoted_from ? ` · promoted from ${l.promoted_from}` : ''}`,
  ]
  if (l.body) lines.push('', ...l.body.split('\n'))
  const max = PARAMS.lessons.showMaxLines
  return lines.length > max ? [...lines.slice(0, max - 1), `… +${lines.length - max + 1} more lines in the entry file`] : lines
}

