import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../installer-template'

const dir = join(PACKAGE_ROOT, 'assets', 'diagrams')
const svgs = readdirSync(dir).filter(f => f.endsWith('.svg'))
const read = (f: string) => readFileSync(join(PACKAGE_ROOT, f), 'utf8')

describe('README diagrams', () => {
  it('ship a light and a dark variant of each diagram', () => {
    for (const name of ['hero', 'workflow', 'footprint', 'lesson-loop']) {
      expect(svgs).toContain(`${name}-light.svg`)
      expect(svgs).toContain(`${name}-dark.svg`)
    }
  })

  it('are GitHub-safe static SVG with an accessible name and a 16-unit minimum font size', () => {
    for (const f of svgs) {
      const s = readFileSync(join(dir, f), 'utf8')
      expect(s, f).not.toMatch(/<script|foreignObject|@import|on[a-z]+=/i)
      expect(s.replace('http://www.w3.org/2000/svg', ''), f).not.toMatch(/https?:\/\//)
      expect(s, f).toMatch(/viewBox="0 0 960 \d+"/)
      expect(s, f).toContain('role="img"')
      expect(s, f).toMatch(/<title>[^<]{20,}<\/title>/)
      for (const m of s.matchAll(/font-size="(\d+)"/g)) expect(Number(m[1]), f).toBeGreaterThanOrEqual(16)
    }
  })

  it('show exactly the measured footprint numbers', () => {
    const s = readFileSync(join(dir, 'footprint-light.svg'), 'utf8')
    for (const v of ['>19<', '>5<', '>0<', '>11,846 B<', '>1,385 B<', '>1.34 MB<', '>0.67 MB<', '>−74%<', '>−100%<', '>−88%<', '>−50%<']) expect(s).toContain(v)
    for (const r of ['README.md', 'README.zh-CN.md']) {
      for (const v of ['11,846 B', '1,385 B', '1,338,837 B', '668,029 B', '51b1e00']) expect(read(r)).toContain(v)
    }
  })

  it('both READMEs embed every diagram with dark and light sources, and share a section structure', () => {
    const headings = (s: string) => [...s.matchAll(/^## /gm)].length
    for (const r of ['README.md', 'README.zh-CN.md']) {
      const s = read(r)
      for (const name of ['hero', 'workflow', 'footprint', 'lesson-loop']) {
        expect(s).toContain(`srcset="assets/diagrams/${name}-dark.svg"`)
        expect(s).toContain(`src="assets/diagrams/${name}-light.svg"`)
      }
      expect(s).toContain('osm-ledger')
    }
    expect(headings(read('README.md'))).toBe(headings(read('README.zh-CN.md')))
    for (const f of ['AGENTS.md', 'FORK.md']) expect(read(f)).toContain('osm-ledger')
  })
})
