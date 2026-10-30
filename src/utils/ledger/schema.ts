import { PARAMS } from './params'

export const STAGES = ['research', 'plan', 'impl', 'review', 'lesson'] as const
export const KINDS = ['stage_completed', 'human_decision', 'probe', 'outcome', 'lesson_state'] as const
export const LESSON_STATES = ['candidate', 'trial', 'adopted', 'retired'] as const
export const SKIP_REASONS = ['dirty-base', 'budget', 'no-verify', 'ledger-off', 'suppressed'] as const
export const DIMENSIONS = ['scope', 'design', 'backend', 'skill', 'permissions', 'acceptance', 'adoption'] as const
export const CHANGE_KINDS = ['feature', 'fix', 'refactor', 'docs', 'test', 'chore'] as const
export const POSITIONS = ['run-hash-v1'] as const

export type Stage = typeof STAGES[number]
export type Kind = typeof KINDS[number]
export type Dimension = typeof DIMENSIONS[number]
export type ChangeKind = typeof CHANGE_KINDS[number]

export interface Cost {
  tokens: number | null
  usd: number | null
}

export interface Invocation {
  backend: string
  role: string
  skills: string[]
  status: 'succeeded' | 'failed' | 'skipped'
  accepted: number | null
  rejected: number | null
  unadjudicated: number | null
  model?: string
  mcp_tools?: string[]
  practices?: string[]
  cost?: Cost
}

export interface ProbeCandidate {
  label: 'A' | 'B'
  has_lesson: boolean
  fingerprint: string
  verify: 'passed' | 'failed' | 'error'
  critical_confirmed: number
  warning_confirmed: number
  diff_lines: number | null
}

/** The part of an event the caller supplies; the CLI adds identity, ordering and harness fields. */
export interface EventInput {
  schema_version: 1
  run_id: string
  change_id: string | null
  stage: Stage
  phase_id: string | null
  kind: Kind
  operation_key: string
  payload: Record<string, any>
}

export interface Harness {
  version: string
  digest: string
  install: string
  files: Record<string, string | null>
  params: string
}

export interface LedgerEvent extends EventInput {
  event_id: string
  seq: number
  recorded_at: string
  project_id: string
  producer: string
  harness: Harness
  /** Observed environment snapshot, computed by the CLI on stage_completed; never supplied by callers. */
  context?: Record<string, unknown>
}

export class ValidationError extends Error {}

type Obj = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`)
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function codePoints(s: string): number {
  return [...s].length
}

// Machine paths that reveal a user or host: system roots, drive letters, UNC shares, file URLs.
// Case-sensitive, like the paths: `/users/123` is a route, `/Users/alice` is a macOS home.
// Route-like text such as `/api/v1`, `/data` or `/osm:impl` is allowed; `/c/Users` (Git Bash) is not.
const SYSTEM_PATH = /(?:^|[^\w.~/-])(?:\/[a-zA-Z](?=\/(?:Users|tmp)\b))?\/(?:(?:home|Users|root|tmp|var|etc|mnt|media|private|usr|snap|Volumes)\b|(?:data|run|srv|opt|workspace)\/[^\s/])/
const OTHER_PATH = /\b[a-z]:[\\/]|\\\\[^\\\s]+\\|file:\/\//i

// Append-time caps (sizes, path guard) apply to new events only; stored history is checked for shape,
// so lowering a cap later never turns old events invalid.
let enforceCaps = true

export function containsAbsolutePath(s: string): boolean {
  return SYSTEM_PATH.test(s) || OTHER_PATH.test(s)
}

function str(v: unknown, path: string, max: number = PARAMS.append.maxText): string {
  if (typeof v !== 'string') fail(path, 'expected string')
  if (!enforceCaps) return v
  if (codePoints(v) > max) fail(path, `longer than ${max} code points`)
  if (containsAbsolutePath(v)) fail(path, 'must not contain an absolute path')
  return v
}

function id(v: unknown, path: string, max = 200): string {
  const s = str(v, path, max)
  if (s.length === 0) fail(path, 'must not be empty')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(s)) fail(path, 'must not contain control characters')
  return s
}

function nullable<T>(v: unknown, path: string, check: (v: unknown, path: string) => T): T | null {
  return v === null ? null : check(v, path)
}

function oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) fail(path, `expected one of ${values.join('|')}`)
  return v as T
}

function int(v: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(path, `expected integer ${min}..${max}`)
  return v
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected boolean')
  return v
}

function arr<T>(v: unknown, path: string, item: (v: unknown, path: string) => T, min = 0, max: number = PARAMS.append.maxArray): T[] {
  if (!Array.isArray(v)) fail(path, 'expected array')
  if (v.length < min || (enforceCaps && v.length > max)) fail(path, `expected ${min}..${max} items`)
  return v.map((x, i) => item(x, `${path}[${i}]`))
}

function obj(v: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Obj {
  if (!isObj(v)) fail(path, 'expected object')
  for (const k of Object.keys(v)) {
    if (!keys.includes(k) && !optional.includes(k)) fail(`${path}.${k}`, 'unknown field')
  }
  for (const k of keys) {
    if (!(k in v)) fail(`${path}.${k}`, 'missing field')
  }
  return v
}

const SLUG = /^[a-z0-9][a-z0-9_-]*$/
function slug(v: unknown, path: string, max = 200): string {
  const s = id(v, path, max)
  if (!SLUG.test(s)) fail(path, 'expected lowercase slug')
  return s
}

/** Optional fields added under schema_version 1: absent or null both mean not reported. */
function optional(o: Obj, key: string, path: string, check: (v: unknown, path: string) => unknown): void {
  if (o[key] !== undefined && o[key] !== null) check(o[key], `${path}.${key}`)
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'must be unique')
}

const MCP_PART = /^[\w.-]{1,64}$/
const MCP_PREFIXED = /^mcp__(.+?)__(.+)$/

/** `<server>:<tool>`; Claude Code's `mcp__server__tool` form is normalized to it. */
function mcpTool(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'expected string')
  const m = MCP_PREFIXED.exec(v)
  const name = m ? `${m[1]}:${m[2]}` : v
  const parts = name.split(':')
  if (parts.length !== 2 || !parts.every(x => MCP_PART.test(x))) fail(path, 'expected <server>:<tool>')
  return name
}

function cost(v: unknown, path: string): Obj {
  // Either member may be left out ("leave a field out rather than estimate"); append fills it in as null.
  const o = obj(v, path, [], ['tokens', 'usd'])
  if (!('tokens' in o) && !('usd' in o)) fail(path, 'expected tokens and/or usd')
  if ('tokens' in o) nullable(o.tokens, `${path}.tokens`, (x, q) => int(x, q, 0, 1e10))
  if ('usd' in o) nullable(o.usd, `${path}.usd`, (x, q) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1e4 || Number(x.toFixed(6)) !== x) fail(q, 'expected number 0..10000 with at most 6 decimals')
    return x
  })
  return o
}

function aiDecisions(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(path, 'expected object')
  for (const k of Object.keys(v)) {
    oneOf(k, `${path}.${k}`, DIMENSIONS)
    int(v[k], `${path}.${k}`, 0, 1000)
  }
  return v
}

function writer(v: unknown, path: string): Obj {
  const o = obj(v, path, ['backend', 'role', 'model'])
  slug(o.backend, `${path}.backend`)
  slug(o.role, `${path}.role`)
  nullable(o.model, `${path}.model`, (x, q) => id(x, q, 64))
  return o
}

export function confidenceBand(percent: number): 'Low' | 'Medium' | 'High' {
  return percent < 50 ? 'Low' : percent >= 80 ? 'High' : 'Medium'
}

function stageCompleted(p: unknown, path: string): Obj {
  const o = obj(p, path, ['status', 'confidence', 'verify', 'invocations'], ['ai_decisions', 'change_kind'])
  oneOf(o.status, `${path}.status`, ['completed', 'failed', 'blocked', 'cancelled'])
  const c = obj(o.confidence, `${path}.confidence`, ['percent'], ['band'])
  const percent = int(c.percent, `${path}.confidence.percent`, 0, 95)
  if ('band' in c && c.band !== confidenceBand(percent)) fail(`${path}.confidence.band`, `must be ${confidenceBand(percent)}`)
  c.band = confidenceBand(percent)
  nullable(o.verify, `${path}.verify`, (v, q) => oneOf(v, q, ['passed', 'failed', 'not_run']))
  arr(o.invocations, `${path}.invocations`, (v, q) => {
    const inv = obj(v, q, ['backend', 'role', 'skills', 'status', 'accepted', 'rejected', 'unadjudicated'], ['model', 'mcp_tools', 'practices', 'cost'])
    slug(inv.backend, `${q}.backend`)
    slug(inv.role, `${q}.role`)
    arr(inv.skills, `${q}.skills`, id)
    oneOf(inv.status, `${q}.status`, ['succeeded', 'failed', 'skipped'])
    for (const k of ['accepted', 'rejected', 'unadjudicated']) nullable(inv[k], `${q}.${k}`, (x, r) => int(x, r))
    optional(inv, 'model', q, (x, r) => id(x, r, 64))
    optional(inv, 'mcp_tools', q, (x, r) => {
      const tools = arr(x, r, mcpTool, 0, 20)
      unique(tools, r)
      inv.mcp_tools = tools
    })
    optional(inv, 'practices', q, (x, r) => unique(arr(x, r, (y, t) => slug(y, t, 40), 0, 10), r))
    optional(inv, 'cost', q, cost)
    return inv
  })
  optional(o, 'ai_decisions', path, aiDecisions)
  optional(o, 'change_kind', path, (v, q) => oneOf(v, q, CHANGE_KINDS))
  return o
}

function humanDecision(p: unknown, path: string): Obj {
  const o = obj(p, path, ['decision_id', 'topic', 'options', 'recommendation', 'initial_choice', 'final_choice', 'final_position', 'blind'], ['dimension', 'position'])
  id(o.decision_id, `${path}.decision_id`)
  str(o.topic, `${path}.topic`, PARAMS.append.maxTopic)
  const options = arr(o.options, `${path}.options`, id, PARAMS.append.minOptions, PARAMS.append.maxOptions)
  unique(options, `${path}.options`)
  const choice = (v: unknown, q: string) => {
    const s = id(v, q)
    if (!options.includes(s)) fail(q, 'must be one of options')
    return s
  }
  nullable(o.recommendation, `${path}.recommendation`, choice)
  nullable(o.initial_choice, `${path}.initial_choice`, choice)
  const final = choice(o.final_choice, `${path}.final_choice`)
  // `options` is the displayed order, so the position must agree with it.
  if (int(o.final_position, `${path}.final_position`, 0, options.length - 1) !== options.indexOf(final)) {
    fail(`${path}.final_position`, 'must be the index of final_choice in options')
  }
  bool(o.blind, `${path}.blind`)
  optional(o, 'dimension', path, (v, q) => oneOf(v, q, DIMENSIONS))
  optional(o, 'position', path, (v, q) => oneOf(v, q, POSITIONS))
  return o
}

function probe(p: unknown, path: string): Obj {
  const o = obj(p, path, ['lesson_id', 'lesson_scope', 'mode', 'skip_reason', 'candidates', 'interdiff_lines', 'ab_map_recorded_after_reviews', 'landed', 'forced'], ['writer', 'change_kind'])
  nullable(o.lesson_id, `${path}.lesson_id`, id)
  nullable(o.lesson_scope, `${path}.lesson_scope`, (v, q) => oneOf(v, q, ['project', 'global']))
  if ((o.lesson_id === null) !== (o.lesson_scope === null)) fail(`${path}.lesson_scope`, 'set together with lesson_id')
  oneOf(o.mode, `${path}.mode`, ['lesson', 'explore'])
  bool(o.forced, `${path}.forced`)
  optional(o, 'writer', path, writer)
  optional(o, 'change_kind', path, (v, q) => oneOf(v, q, CHANGE_KINDS))
  if (o.mode === 'lesson' && o.lesson_id === null) fail(`${path}.lesson_id`, 'required for a lesson probe')
  if (o.mode === 'explore' && o.lesson_id !== null) fail(`${path}.lesson_id`, 'must be null for an explore probe')
  const skip = nullable(o.skip_reason, `${path}.skip_reason`, (v, q) => oneOf(v, q, SKIP_REASONS))
  if (skip !== null) {
    if (!Array.isArray(o.candidates) || o.candidates.length !== 0) fail(`${path}.candidates`, 'must be [] when skipped')
    if (o.interdiff_lines !== null || o.landed !== null || o.ab_map_recorded_after_reviews !== null) {
      fail(path, 'interdiff_lines, landed and ab_map_recorded_after_reviews must be null when skipped')
    }
    return o
  }
  const candidates = arr(o.candidates, `${path}.candidates`, (v, q) => {
    const c = obj(v, q, ['label', 'has_lesson', 'fingerprint', 'verify', 'critical_confirmed', 'warning_confirmed', 'diff_lines'])
    oneOf(c.label, `${q}.label`, ['A', 'B'])
    bool(c.has_lesson, `${q}.has_lesson`)
    id(c.fingerprint, `${q}.fingerprint`)
    oneOf(c.verify, `${q}.verify`, ['passed', 'failed', 'error'])
    int(c.critical_confirmed, `${q}.critical_confirmed`)
    int(c.warning_confirmed, `${q}.warning_confirmed`)
    nullable(c.diff_lines, `${q}.diff_lines`, (x, r) => int(x, r))
    return c
  }, 2, 2)
  if (candidates.length !== 2) fail(`${path}.candidates`, 'expected exactly 2 candidates')
  if (candidates[0].label === candidates[1].label) fail(`${path}.candidates`, 'labels must be A and B')
  if (o.mode === 'lesson' && candidates.filter(c => c.has_lesson).length !== 1) {
    fail(`${path}.candidates`, 'exactly one candidate must have the lesson')
  }
  int(o.interdiff_lines, `${path}.interdiff_lines`)
  if (o.ab_map_recorded_after_reviews !== true) fail(`${path}.ab_map_recorded_after_reviews`, 'must be true')
  oneOf(o.landed, `${path}.landed`, ['A', 'B'])
  return o
}

function outcome(p: unknown, path: string): Obj {
  const o = obj(p, path, ['target', 'assessment', 'result', 'critical_count'])
  const t = obj(o.target, `${path}.target`, ['change_id', 'stage', 'phase_id'])
  id(t.change_id, `${path}.target.change_id`)
  oneOf(t.stage, `${path}.target.stage`, ['research', 'plan', 'impl', 'review'])
  nullable(t.phase_id, `${path}.target.phase_id`, id)
  oneOf(o.assessment, `${path}.assessment`, ['verify', 'review'])
  oneOf(o.result, `${path}.result`, ['passed', 'failed', 'unknown'])
  nullable(o.critical_count, `${path}.critical_count`, (x, r) => int(x, r))
  return o
}

function lessonState(p: unknown, path: string): Obj {
  const o = obj(p, path, ['lesson_id', 'scope', 'from', 'to', 'reason', 'tally'])
  id(o.lesson_id, `${path}.lesson_id`)
  oneOf(o.scope, `${path}.scope`, ['project', 'global'])
  nullable(o.from, `${path}.from`, (v, q) => oneOf(v, q, LESSON_STATES))
  oneOf(o.to, `${path}.to`, LESSON_STATES)
  str(o.reason, `${path}.reason`)
  const t = obj(o.tally, `${path}.tally`, ['W', 'L', 'T', 'inert', 'void', 'changes_with_wins', 'severe_losses'])
  for (const k of Object.keys(t)) int(t[k], `${path}.tally.${k}`)
  return o
}

const PAYLOADS: Record<Kind, (p: unknown, path: string) => Obj> = {
  stage_completed: stageCompleted,
  human_decision: humanDecision,
  probe,
  outcome,
  lesson_state: lessonState,
}

const INPUT_KEYS = ['schema_version', 'run_id', 'change_id', 'stage', 'phase_id', 'kind', 'operation_key', 'payload'] as const

/** Validates a caller-supplied event. Fields the CLI assigns (ids, seq, timestamps, harness) are rejected. */
export function validateInput(raw: unknown): EventInput {
  if (isObj(raw) && 'context' in raw) fail('event.context', 'assigned by the CLI')
  const o = obj(raw, 'event', INPUT_KEYS)
  if (o.schema_version !== 1) fail('event.schema_version', 'must be 1')
  id(o.run_id, 'event.run_id')
  nullable(o.change_id, 'event.change_id', id)
  const stage = oneOf(o.stage, 'event.stage', STAGES)
  nullable(o.phase_id, 'event.phase_id', id)
  const kind = oneOf(o.kind, 'event.kind', KINDS)
  id(o.operation_key, 'event.operation_key')
  if (stage === 'impl' && kind === 'stage_completed' && o.phase_id === null) fail('event.phase_id', 'required for impl stage_completed')
  if (kind === 'outcome' && isObj(o.payload) && 'target_event_id' in o.payload) fail('event.payload.target_event_id', 'assigned by the CLI')
  PAYLOADS[kind](o.payload, 'event.payload')
  return o as unknown as EventInput
}

/** Whether a line read back from a log is a well-formed stored event; anything else counts as invalid. */
export function isStoredEvent(raw: unknown): raw is LedgerEvent {
  if (!isObj(raw)) return false
  const e = raw as Record<string, any>
  if (typeof e.event_id !== 'string' || !Number.isInteger(e.seq) || typeof e.recorded_at !== 'string' || typeof e.project_id !== 'string') return false
  if (!isObj(e.harness) || typeof e.harness.install !== 'string' || typeof e.harness.digest !== 'string' || typeof e.harness.params !== 'string' || !isObj(e.harness.files)) return false
  if (!isObj(e.payload)) return false
  if ('context' in e && !isObj(e.context)) return false
  const { target_event_id, ...payload } = e.payload
  if (e.kind === 'outcome' && typeof target_event_id !== 'string') return false
  enforceCaps = false
  try {
    validateInput({ schema_version: e.schema_version, run_id: e.run_id, change_id: e.change_id, stage: e.stage, phase_id: e.phase_id, kind: e.kind, operation_key: e.operation_key, payload: structuredClone(payload) })
    return true
  }
  catch {
    return false
  }
  finally {
    enforceCaps = true
  }
}
