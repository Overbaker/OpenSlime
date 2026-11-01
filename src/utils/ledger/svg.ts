import type { DecisionRow, DimensionView, ItemRow } from './dimensions'
import { MONO_STACK, SANS_STACK } from '../svg-lint'
import { PARAMS } from './params'
import { containsAbsolutePath } from './schema'

export const RENDER_MARKER = '<!-- osm-ledger render -->'

export type Theme = 'light' | 'dark'

export interface RenderData {
  label: string
  events: number
  runs: number
  changes: number
  first: string | null
  last: string | null
  view: DimensionView
  decisions: DecisionRow[]
  /** Randomized decisions where the user chose the option shown first (`first`) out of `n`; `excluded` were not randomized. */
  position: { first: number, n: number, excluded: number }
  /** Names that must not appear (the repo basename unless --show-names). */
  hide?: string[]
}

type Colors = Record<'bg' | 'panel' | 'border' | 'ink' | 'ink2' | 'grid' | 'better' | 'worse' | 'neutral' | 'unknown', string>

const PALETTE: Record<Theme, Colors> = {
  light: { bg: '#ffffff', panel: '#f7f9f8', border: '#e3e7ea', ink: '#16181d', ink2: '#5b6170', grid: '#d5dade', better: '#2f9e76', worse: '#8b7fd0', neutral: '#b7bec7', unknown: '#eceff2' },
  dark: { bg: '#0d1117', panel: '#111820', border: '#242c36', ink: '#f2f3f5', ink2: '#a3a8b4', grid: '#3a434e', better: '#37a87d', worse: '#8f82e6', neutral: '#4a5462', unknown: '#1b232c' },
}

const W = 960
const PAD = 40

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' })[c]!)
}

/** Estimated advance at 16 px: wide (CJK, fullwidth, emoji) characters count as a full em. */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!
  return cp >= 0x1100 && (cp <= 0x115F || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || cp >= 0x1F300) ? 16 : 9.5
}

/**
 * Cut to `max` code points and about `px` pixels; control characters, noncharacters and lone surrogates dropped.
 */
export function cutName(s: string, max = PARAMS.render.nameMax, px = 300): string {
  // Iterating by code point leaves a lone surrogate as a one-unit string in the surrogate range.
  const chars = [...s].filter((ch) => {
    const cp = ch.codePointAt(0)!
    return !(cp <= 0x1F || cp === 0x7F || cp === 0xFFFE || cp === 0xFFFF || (cp >= 0xD800 && cp <= 0xDFFF))
  })
  let width = 0
  let n = 0
  while (n < chars.length && n < max && width + charWidth(chars[n]) <= px) width += charWidth(chars[n++])
  return n < chars.length ? `${chars.slice(0, Math.max(0, n - 1)).join('')}…` : chars.join('')
}

/**
 * An item name as shown. Real paths and URLs, names that would trip the SVG lint, and hidden names become
 * `(hidden)`; a single inner slash (`provider/model`) stays visible.
 */
export function shown(name: string, hide: string[]): string {
  // Test what will be drawn: cutName drops control characters, which could otherwise split a pattern.
  const cut = cutName(name)
  const flat = cutName(name, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  const pathLike = containsAbsolutePath(flat) || /^(?:\/|\.{1,2}\/|~)|\\|:\/\/|\/.*\//.test(flat)
  const lintLike = /javascript:|data:[a-z]+\/|foreignObject|@import|<script|\b(?:on[a-z]+|style|href)\s*=/i.test(flat)
  // Hidden names (the repo basename) are hidden inside longer names too, but only when long enough to be specific.
  const hidden = hide.some(h => h === flat || (h.length >= 4 && flat.toLowerCase().includes(h.toLowerCase())))
  return pathLike || lintLike || hidden ? '(hidden)' : cut
}

const FAMILY = { sans: escapeXml(SANS_STACK), mono: escapeXml(MONO_STACK) }

function text(x: number, y: number, body: string, o: { size?: number, fill: string, weight?: number, anchor?: 'start' | 'middle' | 'end', mono?: boolean }): string {
  return `<text x="${x}" y="${y}" font-size="${o.size ?? 16}" font-family="${o.mono ? FAMILY.mono : FAMILY.sans}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''} fill="${o.fill}">${escapeXml(body)}</text>`
}

function fx(v: number): string {
  return v.toFixed(4)
}

/** One rejected (item, metric) row: the difference and its interval on a fixed −1..1 axis, with the direction in words. */
function itemRow(r: ItemRow, y: number, c: Colors, hide: string[]): string[] {
  const x0 = 360
  const x1 = 640
  const sx = (v: number) => Math.round((x0 + (Math.max(-1, Math.min(1, v)) + 1) / 2 * (x1 - x0)) * 10) / 10
  const color = r.direction === 'better' ? c.better : c.worse
  const [l, u] = r.interval!
  return [
    text(PAD, y, shown(r.item, hide), { fill: c.ink, weight: 600 }),
    text(PAD, y + 24, `${r.metric} · ${r.direction}`, { fill: c.ink2 }),
    `<line x1="${x0}" y1="${y - 5}" x2="${x1}" y2="${y - 5}" stroke="${c.grid}" stroke-width="1"/>`,
    `<line x1="${sx(0)}" y1="${y - 15}" x2="${sx(0)}" y2="${y + 5}" stroke="${c.neutral}" stroke-width="1"/>`,
    `<line x1="${sx(l)}" y1="${y - 5}" x2="${sx(u)}" y2="${y - 5}" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`,
    `<circle cx="${sx(r.diff!)}" cy="${y - 5}" r="6" fill="${color}"/>`,
    text(x0, y + 48, `diff ${fx(r.diff!)} [${fx(l)}, ${fx(u)}]`, { fill: c.ink2, mono: true }),
    text(W - PAD, y, `with ${r.with.x}/${r.with.n} · ${r.with.runs} runs`, { fill: c.ink2, anchor: 'end', mono: true }),
    text(W - PAD, y + 24, `without ${r.without.x}/${r.without.n} · ${r.without.runs} runs`, { fill: c.ink2, anchor: 'end', mono: true }),
  ]
}

const DECISION_CLASSES = ['adopted', 'reversed', 'overrode', 'unknown'] as const

function decisionRow(r: DecisionRow, y: number, maxN: number, c: Colors): string[] {
  const fill = { adopted: c.better, reversed: c.worse, overrode: c.neutral, unknown: c.unknown }
  const x0 = 180
  const width = 220
  const out = [text(PAD, y, r.dimension, { fill: c.ink, weight: 600 })]
  let x = x0
  for (const k of DECISION_CLASSES) {
    const w = Math.round(r[k] / maxN * width * 10) / 10
    if (w > 0) out.push(`<rect x="${x}" y="${y - 15}" width="${w}" height="18" fill="${fill[k]}"/>`)
    x += w
  }
  out.push(text(x0 + width + 16, y, `adopted ${r.adopted} · reversed ${r.reversed} · overrode ${r.overrode} · unknown ${r.unknown}`, { fill: c.ink2 }))
  return out
}

/** A static, deterministic SVG of one ledger view. Pure: the same data and theme always give the same bytes. */
export function renderSvg(d: RenderData, theme: Theme): string {
  const c = PALETTE[theme]
  const body: string[] = []
  let y = 56
  body.push(text(PAD, y, `OSM ledger · ${cutName(d.label, 48, 480)}`, { size: 24, fill: c.ink, weight: 700 }))
  y += 32
  body.push(text(PAD, y, `n = ${d.events} events · ${d.runs} runs · ${d.changes} changes · data: ${d.first ?? 'none'} – ${d.last ?? 'none'}`, { fill: c.ink2 }))

  y += 52
  body.push(text(PAD, y, `By ${d.view.by} (${d.view.source})`, { size: 20, fill: c.ink, weight: 700 }))
  const rejected = d.view.items.flatMap(it => it.rows.filter(r => r.rejected && r.aliased_of === null))
  const better = rejected.filter(r => r.direction === 'better').slice(0, PARAMS.render.maxItems)
  const worse = rejected.filter(r => r.direction === 'worse').slice(0, PARAMS.render.maxItems)
  y += 20
  for (const [title, rows] of [['associated-better', better], ['associated-worse', worse]] as const) {
    y += 30
    body.push(text(PAD, y, `${title}: ${rows.length ? '' : 'none'}`, { fill: c.ink2, weight: 600 }))
    for (const r of rows) {
      y += 36
      body.push(...itemRow(r, y, c, d.hide ?? []))
      y += 48
    }
  }
  const noVerdict = d.view.items.filter(it => !['associated-better', 'associated-worse', 'mixed'].includes(it.verdict)).length
  y += 36
  body.push(text(PAD, y, `${noVerdict} items: no verdict · Holm over m = ${d.view.holm_m}`, { fill: c.ink2 }))

  const decisions = d.decisions.filter(r => r.n > 0)
  y += 52
  body.push(text(PAD, y, 'Human decisions by dimension', { size: 20, fill: c.ink, weight: 700 }))
  const maxN = Math.max(1, ...decisions.map(r => r.n))
  if (!decisions.length) {
    y += 32
    body.push(text(PAD, y, 'no decisions recorded', { fill: c.ink2 }))
  }
  for (const r of decisions) {
    y += 32
    body.push(...decisionRow(r, y, maxN, c))
  }

  const costs = d.view.items.filter(it => it.cost).slice(0, PARAMS.render.maxItems)
  if (costs.length) {
    y += 52
    body.push(text(PAD, y, 'Cost per arm (mean tokens and USD; never tested)', { size: 20, fill: c.ink, weight: 700 }))
    for (const it of costs) {
      const k = it.cost!
      y += 32
      const tok = (a: typeof k.with) => `${a.tokens === null ? 'unknown' : Math.round(a.tokens)} tokens${a.usd === null ? '' : ` $${a.usd.toFixed(4)}`}`
      body.push(text(PAD, y, shown(it.item, d.hide ?? []), { fill: c.ink, weight: 600 }))
      y += 24
      body.push(text(PAD, y, `with ${tok(k.with)} (n=${k.with.n}) · without ${tok(k.without)} (n=${k.without.n})${k.label ? ` · ${k.label}` : ''}`, { fill: c.ink2 }))
    }
  }

  const p = d.position
  y += 52
  body.push(text(PAD, y, p.n < PARAMS.rubberStamp.minDecisions
    ? `not enough randomized decisions (${p.n}; not randomized: ${p.excluded})`
    : `chose the first-shown option: ${p.first} of ${p.n} randomized decisions (not randomized: ${p.excluded})`, { fill: c.ink2 }))
  y += 44
  body.push(`<line x1="${PAD}" y1="${y - 26}" x2="${W - PAD}" y2="${y - 26}" stroke="${c.border}" stroke-width="1"/>`)
  body.push(text(PAD, y, 'associations, not causes · verdicts never change OpenSlime', { fill: c.ink2 }))
  const h = y + 36
  const title = `OSM ledger view of ${cutName(d.label, 48)} by ${d.view.by}, with decisions by dimension`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img">`,
    RENDER_MARKER,
    `<title>${escapeXml(title)}</title>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="16" fill="${c.bg}" stroke="${c.border}"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n')
}
