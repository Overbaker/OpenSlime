import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../installer-template'
import { lintSvg } from '../svg-lint'

const dir = join(PACKAGE_ROOT, 'assets', 'diagrams')
const svgs = readdirSync(dir).filter(f => f.endsWith('.svg'))
const read = (f: string) => readFileSync(join(PACKAGE_ROOT, f), 'utf8')

describe('README diagrams', () => {
  it('ship a light and a dark variant of each diagram', () => {
    for (const name of ['hero', 'workflow', 'compare', 'dimensions', 'lesson-loop']) {
      expect(svgs).toContain(`${name}-light.svg`)
      expect(svgs).toContain(`${name}-dark.svg`)
    }
  })

  it('are GitHub-safe static SVG with an accessible name and a 16-unit minimum font size', () => {
    for (const f of svgs) {
      expect(lintSvg(readFileSync(join(dir, f), 'utf8')), f).toEqual([])
    }
  })

  it('compare card shows exactly the measured numbers; footprint is gone', () => {
    const s = readFileSync(join(dir, 'compare-light.svg'), 'utf8')
    expect(s).toContain('Compared with ccg-workflow 51b1e00')
    for (const v of ['>5<', '>0<', '>11.8 KB<', '>1.4 KB<', '>19<']) expect(s).toContain(v)
    expect(svgs.some(f => f.startsWith('footprint-'))).toBe(false)
    for (const r of ['README.md', 'README.zh-CN.md']) {
      for (const v of ['11,846 B', '1,385 B', '1,338,837 B', '668,029 B', '51b1e00']) expect(read(r)).toContain(v)
      expect(read(r)).not.toContain('footprint')
    }
  })

  it('Q19: the dimensions schematic has no digit in any text node', () => {
    for (const f of ['dimensions-light.svg', 'dimensions-dark.svg']) {
      const s = readFileSync(join(dir, f), 'utf8')
      const nodes = [...s.matchAll(/<(text|tspan|title)[^>]*>([^<]*)</g)].map(m => m[2])
      expect(nodes.length, f).toBeGreaterThan(20)
      for (const n of nodes) expect(n, f).not.toMatch(/\d/)
    }
  })

  it('both READMEs embed every diagram with dark and light sources, and share a section structure', () => {
    const headings = (s: string) => [...s.matchAll(/^## /gm)].length
    for (const r of ['README.md', 'README.zh-CN.md']) {
      const s = read(r)
      for (const name of ['hero', 'workflow', 'compare', 'dimensions', 'lesson-loop']) {
        expect(s).toContain(`srcset="assets/diagrams/${name}-dark.svg"`)
        expect(s).toContain(`src="assets/diagrams/${name}-light.svg"`)
      }
      expect(s).toContain('osm-ledger')
      for (const v of ['summary --by <', 'summary --by decision', 'render --svg']) expect(s).toContain(v)
    }
    expect(headings(read('README.md'))).toBe(headings(read('README.zh-CN.md')))
    for (const f of ['AGENTS.md', 'FORK.md']) expect(read(f)).toContain('osm-ledger')
  })
})
