import type { LedgerEvent } from '../utils/ledger/schema'
import type { LessonResult } from '../utils/ledger/lessons'
import type { LockedContext } from '../utils/ledger/store'
import { isStoredEvent, validateInput } from '../utils/ledger/schema'
import { addLesson, adoptLesson, autoRetire, cardLines, effectiveState, lessonCard, lessonsDir, promoteLesson, queryLessons, queryLine, readLessons, retireLesson, showLesson } from '../utils/ledger/lessons'
import { lessonTally } from '../utils/ledger/probe'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { version } from '../../package.json'
import { basename, dirname, join } from 'pathe'
import { currentInstall } from '../utils/ledger/harness'
import { PARAMS } from '../utils/ledger/params'
import type { DimensionKey } from '../utils/ledger/dimensions'
import { decisionView, DIMENSION_KEYS, dimensionView } from '../utils/ledger/dimensions'
import { bound, BoundsError, cohortLines, decisionLines, dimensionLines, parseBounds, ruleLines, summaryLines } from '../utils/ledger/render'
import { cohorts, cohortView, evaluateRules } from '../utils/ledger/rules'
import { byCodePoint, summarize } from '../utils/ledger/summary'
import { defaultInstallDir, defaultLedgerRoot, disabledMarker, globalLog, projectDir, projectLog } from '../utils/ledger/paths'
import { resolveProject } from '../utils/ledger/project'
import type { RenderData, Theme } from '../utils/ledger/svg'
import { RENDER_MARKER, renderSvg, shown } from '../utils/ledger/svg'
import { lintSvg } from '../utils/svg-lint'
import { appendEvent, EXIT, ledgerDisabled, lockInfo, readLog, recommendedIndex } from '../utils/ledger/store'

export interface LedgerOptions {
  json?: boolean
  projectRoot?: string
  root?: string
  installDir?: string
  project?: string
  allProjects?: boolean
  byHarness?: boolean
  by?: string
  svg?: boolean
  out?: string
  theme?: string
  force?: boolean
  showNames?: boolean
  window?: unknown
  runs?: unknown
  params?: boolean
  limit?: unknown
  maxBytes?: unknown
  files?: string
  kind?: string
  text?: string
  scope?: string
  all?: boolean
  decision?: string
  confirm?: boolean
  reason?: string
  runId?: string
  change?: string
  lesson?: string
  decisionId?: string
  options?: string
}

const USAGE = [
  'Usage: osm ledger <command>',
  '  status [--json]        recording state, ledger root, project id, counts',
  '  on | off               turn recording on or off for this user',
  '  run-id                 print a new run id for one stage invocation',
  '  append [--project-root PATH]   append one JSON event read from stdin',
  '  summary [--project ID|--all-projects] [--by-harness | --by DIM|decision [--window 7|30|90] [--runs N]] [--json] [--limit N] [--max-bytes N]',
  '  render --svg [--out BASE.svg|-] [--theme light|dark|both] [--by DIM] [--project ID|--all-projects] [--force] [--show-names]',
  '  harness [--params] [--json]    built-in rules H-0001..H-0005 and the current install digest',
  '  lessons query [--files a,b] [--kind backend|frontend|any] [--text S] [--scope project|global|both] [--limit N] [--all]',
  '  probes --change ID [--lesson ID --scope S]   probe counts for the impl budget',
  '  position --run-id R --decision-id D --options K   where a randomized recommendation goes (0-based)',
  '  lessons show ID [--scope S] | add (stdin JSON) | adopt ID --decision EVENT --confirm | retire ID --reason S | promote ID --decision EVENT --confirm',
].join('\n')

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function status(opts: LedgerOptions, root: string): number {
  const project = resolveProject(opts.projectRoot ?? process.cwd())
  const { events, invalid } = readLog(projectLog(root, project.id))
  const lessons = readLessons(lessonsDir(root, 'project', project.id)).filter(l => effectiveState(events, 'project', l.id, l.state) !== 'retired').length
  const lock = lockInfo(projectLog(root, project.id))
  const report = {
    enabled: !ledgerDisabled(root),
    root,
    project_id: project.id,
    project_name: project.name,
    events: events.length,
    invalid,
    lessons,
    lock,
  }
  if (opts.json) {
    out(JSON.stringify(report))
  }
  else {
    out(`Ledger: ${report.enabled ? 'on' : 'off'} · ${root}`)
    out(`Project: ${project.name} (${project.id}) · ${events.length} events · ${lessons} lessons${invalid ? ` · invalid: ${invalid}` : ''}`)
    if (lock) out(`Lock held: pid ${lock.pid ?? '?'} on ${lock.host ?? '?'}, ${Math.round(lock.age_ms / 1000)}s old · if no writer is running: rm '${lock.path}'`)
  }
  return EXIT.ok
}

function readStdin(): string | null {
  if (process.stdin.isTTY) return null
  try {
    return readFileSync(0, 'utf8')
  }
  catch {
    return null
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * Appends hold a lock that is never stolen, so a signal must not end the process mid-append.
 * The append is synchronous; a handled signal is only acted on after it returns and releases the lock.
 */
function deferSignals<T>(fn: () => T): T {
  const onSignal = (): void => { process.exitCode = 130 }
  for (const sig of SIGNALS) process.on(sig, onSignal)
  try {
    return fn()
  }
  finally {
    // A signal that arrived during fn is dispatched in a later poll phase, which can come after an
    // immediate; a short timer keeps the handler (and the loop) alive until it has been delivered.
    setTimeout(() => { for (const sig of SIGNALS) process.off(sig, onSignal) }, 100)
  }
}

function append(opts: LedgerOptions, root: string): number {
  if (ledgerDisabled(root)) {
    out(JSON.stringify({ status: 'disabled', event_id: null }))
    return EXIT.ok
  }
  const text = readStdin()
  if (text === null || !text.trim()) {
    process.stderr.write('append: expected one JSON event on stdin\n')
    return EXIT.invalid
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (error) {
    process.stderr.write(`append: invalid JSON: ${(error as Error).message}\n`)
    return EXIT.invalid
  }
  const after = (ctx: LockedContext) => {
    // appendEvent already validated `raw`; storage errors from autoRetire must surface as exit 4.
    const input = validateInput(raw)
    return autoRetire(ctx, input, input.run_id)
  }
  const result = deferSignals(() => appendEvent(raw, { root, installDir: opts.installDir, projectRoot: opts.projectRoot, version, after }))
  if (result.code === 0) {
    out(JSON.stringify(result.receipt))
    return EXIT.ok
  }
  process.stderr.write(`append: ${result.error}\n`)
  return result.code
}

interface Loaded {
  title: string
  /** The project id, or null for --all-projects; `name` is the repo basename when known. Render shows neither by default. */
  id?: string | null
  name?: string | null
  /** Repo basenames of every project in the view, from meta.json; render hides them unless --show-names. */
  repoNames?: string[]
  events: LedgerEvent[]
  invalid: number
}

/** Reads logs and keeps only well-formed stored events; the rest are counted as invalid. */
function readValid(paths: string[]): { events: LedgerEvent[], invalid: number } {
  const perLog: LedgerEvent[][] = []
  let invalid = 0
  for (const path of paths) {
    const log = readLog(path)
    invalid += log.invalid
    const valid = log.events.filter(isStoredEvent)
    invalid += log.events.length - valid.length
    if (valid.length) perLog.push(valid)
  }
  if (perLog.length <= 1) return { events: perLog[0] ?? [], invalid }
  // Seq numbers from different logs are not comparable (even under one project id). Each log keeps its own
  // seq order; logs are interleaved by the head events' recorded_at (ties to the earlier log), then renumbered.
  const queues = perLog.map(events => [...events].sort((a, b) => a.seq - b.seq))
  const merged: LedgerEvent[] = []
  while (queues.some(q => q.length)) {
    let pick = -1
    for (let i = 0; i < queues.length; i++) {
      if (queues[i].length && (pick < 0 || byCodePoint(queues[i][0].recorded_at, queues[pick][0].recorded_at) < 0)) pick = i
    }
    merged.push({ ...queues[pick].shift()!, seq: merged.length + 1 })
  }
  return { events: merged, invalid }
}

/** The repo basename recorded for a project id, or null. */
function metaName(root: string, id: string): string | null {
  try {
    const name = JSON.parse(readFileSync(join(projectDir(root, id), 'meta.json'), 'utf8'))?.name
    return typeof name === 'string' && name ? name : null
  }
  catch {
    return null
  }
}

function load(opts: LedgerOptions, root: string): Loaded {
  if (opts.allProjects && opts.project) throw new BoundsError('--project and --all-projects are exclusive')
  if (opts.allProjects) {
    let ids: string[] = []
    try {
      ids = readdirSync(join(root, 'projects')).filter(d => /^p_[0-9a-f]{16}$/.test(d)).sort()
    }
    catch {}
    return { title: `OSM ledger · all projects (${ids.length})`, id: null, name: `all projects (${ids.length})`, repoNames: ids.flatMap(id => metaName(root, id) ?? []), ...readValid([...ids.map(id => projectLog(root, id)), globalLog(root)]) }
  }
  let id: string
  let name: string
  let base: string | null = null
  if (opts.project) {
    if (!/^p_[0-9a-f]{16}$/.test(opts.project)) throw new BoundsError('--project must look like p_<16 hex>')
    id = opts.project
    name = id
    base = metaName(root, id)
  }
  else {
    const p = resolveProject(opts.projectRoot ?? process.cwd())
    id = p.id
    name = `${p.name} (${p.id})`
    base = p.name
  }
  // Global lesson state lives in the global log (decision 6); H-0002 needs it in every scope.
  return { title: `OSM ledger · ${name}`, id, name: base, repoNames: base ? [base] : [], ...readValid([projectLog(root, id), globalLog(root)]) }
}

function capGroups<T>(list: T[], limit: number): { shown: T[], omitted: number } {
  return { shown: list.slice(0, limit), omitted: Math.max(0, list.length - limit) }
}

function byDimension(opts: LedgerOptions, data: Loaded, b: ReturnType<typeof parseBounds>): number {
  const by = opts.by!
  if (by === 'decision') {
    const rows = decisionView(data.events)
    if (opts.json) out(JSON.stringify({ title: data.title, invalid: data.invalid, by, rows }))
    else process.stdout.write(bound(decisionLines(data.title, rows), b))
    return EXIT.ok
  }
  if (!(DIMENSION_KEYS as readonly string[]).includes(by)) throw new BoundsError(`--by must be one of ${[...DIMENSION_KEYS, 'decision'].join(', ')}`)
  const windowDays = opts.window === undefined ? undefined : Number(opts.window)
  if (windowDays !== undefined && ![7, 30, 90].includes(windowDays)) throw new BoundsError('--window must be 7, 30 or 90')
  const runs = opts.runs === undefined ? undefined : Number(opts.runs)
  if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) throw new BoundsError('--runs must be a positive integer')
  const v = dimensionView(data.events, by as DimensionKey, { windowDays, runs })
  if (opts.json) {
    const g = capGroups(v.items, b.limit)
    const max = PARAMS.stats.maxRows
    const shown = g.shown.map(it => ({ ...it, rows: it.rows.map(r => ({ ...r, aliased_with: r.aliased_with.slice(0, max), aliased_omitted: Math.max(0, r.aliased_with.length - max) })) }))
    out(JSON.stringify({ title: data.title, invalid: data.invalid, ...v, totals: { items: v.items.length, tested: v.holm_m }, items: shown, omitted_items: g.omitted }))
  }
  else {
    process.stdout.write(bound(dimensionLines(data.title, v), b))
  }
  return EXIT.ok
}

function renderData(opts: LedgerOptions, data: Loaded): RenderData {
  const by = opts.by ?? 'skill'
  if (!(DIMENSION_KEYS as readonly string[]).includes(by)) throw new BoundsError(`--by must be one of ${DIMENSION_KEYS.join(', ')}`)
  const ev = data.events
  // Only well-formed UTC timestamps reach the header; anything else in a hand-edited log is skipped.
  const dates = ev.map(e => e.recorded_at).filter(t => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(t) && new Date(t).toISOString().slice(0, 10) === t.slice(0, 10)).sort()
  const decisions = ev.filter(e => e.kind === 'human_decision')
  const marked = decisions.filter(e => e.payload.position === 'run-hash-v1')
  const label = data.id === null || data.id === undefined
    ? (data.name ?? 'all projects')
    : `project ${data.id.slice(2, 8)}${opts.showNames && data.name ? ` · ${shown(data.name, [])}` : ''}`
  return {
    label,
    events: ev.length,
    runs: new Set(ev.map(e => e.run_id)).size,
    changes: new Set(ev.flatMap(e => (e.change_id ? [e.change_id] : []))).size,
    first: dates.length ? dates[0].slice(0, 10) : null,
    last: dates.length ? dates[dates.length - 1].slice(0, 10) : null,
    view: dimensionView(ev, by as DimensionKey),
    decisions: decisionView(ev),
    position: { first: marked.filter(e => e.payload.final_position === 0).length, n: marked.length, excluded: decisions.filter(e => e.payload.recommendation !== null && !e.payload.blind && e.payload.position !== 'run-hash-v1').length },
    hide: opts.showNames ? [] : data.repoNames ?? [],
  }
}

/** Writes SVGs under the ledger's renders/ directory (or --out); never writes events or inside a repo by default. */
function render(opts: LedgerOptions, root: string): number {
  if (!opts.svg) throw new BoundsError('render needs --svg')
  const theme = opts.theme ?? 'both'
  if (!['light', 'dark', 'both'].includes(theme)) throw new BoundsError('--theme must be light, dark or both')
  if (opts.out === '' || (opts.out !== undefined && opts.out !== '-' && !opts.out.endsWith('.svg'))) throw new BoundsError('--out needs a path ending in .svg, or -')
  if (opts.out === '-' && theme === 'both') throw new BoundsError('--out - writes one theme; add --theme light or --theme dark')
  const data = load(opts, root)
  const d = renderData(opts, data)
  const themes: Theme[] = theme === 'both' ? ['light', 'dark'] : [theme as Theme]
  const svgs = new Map(themes.map(t => [t, renderSvg(d, t)]))
  for (const [t, s] of svgs) {
    const problems = lintSvg(s)
    if (problems.length) throw new Error(`render ${t} failed the SVG lint: ${problems.join('; ')}`)
  }
  if (opts.out === '-') {
    process.stdout.write(svgs.get(themes[0])!)
    return EXIT.ok
  }
  const stem = opts.out ? opts.out.slice(0, -4) : join(root, 'renders', data.id ?? 'all-projects')
  const target = (t: Theme) => (opts.out && theme !== 'both' ? opts.out : `${stem}-${t}.svg`)
  // Check every target before writing any, so a refusal never leaves half the output behind.
  for (const t of themes) {
    const f = target(t)
    let st
    try {
      st = lstatSync(f)
    }
    catch {
      continue
    }
    if (!st.isFile()) throw new BoundsError(`${f} exists and is not a regular file (symlink or directory); refusing to write`)
    if (!opts.force && readFileSync(f, 'utf8').split(/\r?\n/)[1] !== RENDER_MARKER) throw new BoundsError(`${f} exists and was not written by osm ledger render; use --force`)
  }
  for (const t of themes) {
    const f = target(t)
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
    // A fresh sibling opened with O_EXCL, then renamed over the target: never follows a link planted at the target.
    const tmpFile = join(dirname(f), `.${basename(f)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
    try {
      writeFileSync(tmpFile, svgs.get(t)!, { mode: 0o600, flag: 'wx' })
      renameSync(tmpFile, f)
    }
    catch (error) {
      rmSync(tmpFile, { force: true })
      throw error
    }
    out(f)
  }
  // Paths in the snippet are as given with --out (relative stays relative); default renders are named by basename.
  const src = (t: Theme) => (opts.out ? target(t) : basename(target(t)))
  out(themes.length === 2
    ? `<picture><source media="(prefers-color-scheme: dark)" srcset="${src('dark')}"><img alt="OSM ledger" src="${src('light')}"></picture>`
    : `<img alt="OSM ledger" src="${src(themes[0])}">`)
  return EXIT.ok
}

function summary(opts: LedgerOptions, root: string): number {
  const b = parseBounds(opts.limit, opts.maxBytes)
  if (opts.by !== undefined && opts.byHarness) throw new BoundsError('--by and --by-harness are exclusive')
  if ((opts.window !== undefined || opts.runs !== undefined) && (opts.by === undefined || opts.by === 'decision')) throw new BoundsError('--window and --runs need --by <dim>')
  const data = load(opts, root)
  // A pure function of the logs: the current install and the H-rules are reported by `osm ledger harness`.
  if (opts.byHarness) {
    const c = cohorts(data.events)
    if (opts.json) out(JSON.stringify({ title: data.title, invalid: data.invalid, ...c }))
    else process.stdout.write(bound(cohortLines(c.cohorts, c.omitted, data.invalid), b))
    return EXIT.ok
  }
  if (opts.by !== undefined) return byDimension(opts, data, b)
  const s = summarize(data.events)
  if (opts.json) {
    let omitted = 0
    const participants = Object.fromEntries((['backend', 'role', 'skill'] as const).map((k) => {
      const g = capGroups(s.participants[k], b.limit)
      omitted += g.omitted
      return [k, g.shown]
    }))
    out(JSON.stringify({
      title: data.title,
      invalid: data.invalid,
      totals: { events: s.events, backend: s.participants.backend.length, role: s.participants.role.length, skill: s.participants.skill.length },
      ...s,
      participants,
      omitted_groups: omitted,
    }))
  }
  else {
    process.stdout.write(bound(summaryLines(data.title, s, data.invalid), b))
  }
  return EXIT.ok
}

function harness(opts: LedgerOptions, root: string): number {
  if (opts.params) {
    out(JSON.stringify(PARAMS, null, opts.json ? undefined : 2))
    return EXIT.ok
  }
  const data = load(opts, root)
  const install = currentInstall(opts.installDir ?? process.env.OSM_INSTALL_DIR ?? defaultInstallDir())
  const current = evaluateRules(cohortView(data.events, install))
  const all = evaluateRules(data.events)
  if (opts.json) out(JSON.stringify({ install, current, all }))
  else process.stdout.write(bound(ruleLines(install, current, all), parseBounds(undefined, undefined)))
  return EXIT.ok
}

/** Probe counts for the impl budget: unforced, non-skipped lesson probes in one change, and per lesson. */
function probesCmd(opts: LedgerOptions & { change?: string, lesson?: string }, root: string): number {
  if (!opts.change) throw new BoundsError('probes: --change <id> is required')
  const project = resolveProject(opts.projectRoot ?? process.cwd())
  const scope = scopeOf(opts.scope, false)
  const probes = readValid([projectLog(root, project.id)]).events
    .filter(e => e.kind === 'probe' && e.change_id === opts.change && e.payload.skip_reason === null && e.payload.mode === 'lesson')
  const unforced = probes.filter(e => !e.payload.forced).length
  const lesson = opts.lesson ? probes.filter(e => e.payload.lesson_id === opts.lesson && e.payload.lesson_scope === scope).length : null
  out(JSON.stringify({ change: opts.change, unforced_in_change: unforced, lesson_in_change: lesson, budget: { per_change: PARAMS.probe.perChange, per_session: PARAMS.probe.perSession, per_lesson_per_change: PARAMS.probe.perLessonPerChange } }))
  return EXIT.ok
}

function scopeOf(v: string | undefined, allowBoth: boolean): 'project' | 'global' | 'both' {
  const s = v ?? (allowBoth ? 'both' : 'project')
  if (s === 'project' || s === 'global' || (allowBoth && s === 'both')) return s
  throw new BoundsError(`--scope must be project|global${allowBoth ? '|both' : ''}`)
}

function lessonsCmd(args: string[], opts: LedgerOptions, root: string): number {
  const [, sub, id] = args
  const base = { root, installDir: opts.installDir, projectRoot: opts.projectRoot, version, runId: opts.runId ?? `lesson-${randomUUID()}` }
  const report = (r: LessonResult): number => {
    if (r.code === 0) out(opts.json ? JSON.stringify({ message: r.message, ...r.data }) : r.message)
    else process.stderr.write(`lessons ${sub}: ${r.message}\n`)
    return r.code
  }
  const needId = () => {
    if (!id || !/^L-\d{4,}$/.test(id)) throw new BoundsError(`lessons ${sub}: expected a lesson id like L-0001`)
    return id
  }
  if (ledgerDisabled(root) && ['add', 'adopt', 'retire', 'promote'].includes(sub)) {
    out(JSON.stringify({ status: 'disabled' }))
    return EXIT.ok
  }
  switch (sub) {
    case 'query': {
      const project = resolveProject(opts.projectRoot ?? process.cwd())
      const events = readValid([projectLog(root, project.id)]).events
      const limit = opts.limit === undefined ? PARAMS.lessons.queryDefault : Number(opts.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > PARAMS.lessons.queryMax) throw new BoundsError(`--limit must be an integer 1..${PARAMS.lessons.queryMax}`)
      const kind = opts.kind ?? 'any'
      if (!['backend', 'frontend', 'any'].includes(kind)) throw new BoundsError('--kind must be backend|frontend|any')
      const q = { files: (opts.files ?? '').split(',').map(f => f.trim()).filter(Boolean), kind: kind as 'any', text: opts.text ?? '', scope: scopeOf(opts.scope, true), limit, all: !!opts.all }
      const { rows, matched } = queryLessons(root, project.id, events, q)
      if (opts.json) out(JSON.stringify({ matched, rows: rows.map(r => ({ id: r.lesson.id, scope: r.lesson.scope, state: r.state, line: r.lesson.line, cue: r.lesson.cue, conflict: r.conflict, W: r.tally.W, L: r.tally.L, T: r.tally.T })) }))
      else for (const r of rows) out(queryLine(r))
      return EXIT.ok
    }
    case 'show': {
      const scope = scopeOf(opts.scope, false) as 'project' | 'global'
      const project = resolveProject(opts.projectRoot ?? process.cwd())
      const lesson = readLessons(lessonsDir(root, scope, project.id)).find(l => l.id === needId())
      if (!lesson) throw new BoundsError(`${scope} lesson ${id} not found`)
      const events = readValid([projectLog(root, project.id)]).events
      const card = cardLines(lessonCard(events, scope, lesson.id))
      for (const line of showLesson(lesson, effectiveState(events, scope, lesson.id, lesson.state) ?? lesson.state, lessonTally(events, scope, lesson.id), card)) out(line)
      return EXIT.ok
    }
    case 'add': {
      const text = readStdin()
      if (text === null || !text.trim()) throw new BoundsError('lessons add: expected one JSON lesson on stdin')
      let raw: unknown
      try {
        raw = JSON.parse(text)
      }
      catch (error) {
        throw new BoundsError(`lessons add: invalid JSON: ${(error as Error).message}`)
      }
      return report(deferSignals(() => addLesson(raw, base)))
    }
    case 'adopt':
    case 'promote': {
      const lessonId = needId()
      if (!opts.confirm) throw new BoundsError(`lessons ${sub} requires --confirm`)
      if (!opts.decision) throw new BoundsError(`lessons ${sub} requires --decision <event id>`)
      const decision = opts.decision
      return report(deferSignals(() => sub === 'adopt'
        ? adoptLesson(lessonId, scopeOf(opts.scope, false) as 'project', decision, base)
        : promoteLesson(lessonId, decision, base)))
    }
    case 'retire': {
      const lessonId = needId()
      return report(deferSignals(() => retireLesson(lessonId, scopeOf(opts.scope, false) as 'project', opts.reason ?? '', base)))
    }
    default:
      throw new BoundsError(`lessons: unknown command ${sub ?? ''}`.trim())
  }
}

export async function ledger(args: string[], opts: LedgerOptions = {}): Promise<number> {
  try {
    return run(args, opts)
  }
  catch (error: any) {
    process.stderr.write(`ledger: ${error?.message ?? error}\n`)
    return error instanceof BoundsError || error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? EXIT.invalid : EXIT.storage
  }
}

function run(args: string[], opts: LedgerOptions): number {
  const root = opts.root ?? defaultLedgerRoot()
  const [cmd] = args
  switch (cmd) {
    case 'status':
      return status(opts, root)
    case 'on':
      rmSync(disabledMarker(root), { force: true })
      out('Ledger: on')
      return EXIT.ok
    case 'off':
      mkdirSync(root, { recursive: true, mode: 0o700 })
      if (!existsSync(disabledMarker(root))) writeFileSync(disabledMarker(root), '', { mode: 0o600 })
      out('Ledger: off')
      return EXIT.ok
    case 'run-id':
      out(randomUUID())
      return EXIT.ok
    case 'append':
      return append(opts, root)
    case 'summary':
      return summary(opts, root)
    case 'render':
      return render(opts, root)
    case 'harness':
      return harness(opts, root)
    case 'lessons':
      return lessonsCmd(args, opts, root)
    case 'probes':
      return probesCmd(opts, root)
    case 'position': {
      const k = Number(opts.options)
      if (!opts.runId || !opts.decisionId || !Number.isInteger(k) || k < PARAMS.append.minOptions || k > PARAMS.append.maxOptions) {
        throw new BoundsError(`position: --run-id, --decision-id and --options ${PARAMS.append.minOptions}..${PARAMS.append.maxOptions} are required`)
      }
      out(String(recommendedIndex(opts.runId, opts.decisionId, k)))
      return EXIT.ok
    }
    default:
      process.stderr.write(`${cmd ? `Unknown ledger command: ${cmd}\n` : ''}${USAGE}\n`)
      return EXIT.invalid
  }
}
