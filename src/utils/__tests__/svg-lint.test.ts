import { describe, expect, it } from 'vitest'
import { lintSvg, SANS_STACK } from '../svg-lint'

const ok = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 200" role="img"><title>A diagram with a long enough title</title><text font-size="16" font-family="${SANS_STACK.replaceAll('\'', '&apos;')}">x</text></svg>`

describe('svg lint', () => {
  it('passes a clean SVG and flags each rule', () => {
    expect(lintSvg(ok)).toEqual([])
    for (const bad of [
      ok.replace('<text', '<script/><text'),
      ok.replace('<text', '<text onclick="x"'),
      ok.replace('>x<', '>https://example.com<'),
      ok.replace('960 200', '800 200'),
      ok.replace(' role="img"', ''),
      ok.replace('A diagram with a long enough title', 'short'),
      ok.replace('font-size="16"', 'font-size="12"'),
      ok.replace(/font-family="[^"]*"/, 'font-family="Comic Sans"'),
      ok.replace('<text', '<svg onload ="x"/><text'),
      ok.replace('<text', '<a href="javascript:x"/><text'),
      ok.replace('<text', '<use xlink:href="//evil/x"/><text'),
      ok.replace('<text', '<style>text{}</style><text'),
      ok.replace('<text', '<text style="font-size:8px"'),
      ok.replace('<svg', '<!DOCTYPE svg><svg'),
      ok.replace('>x<', '>data:image/png;base64,AA<'),
    ]) expect(lintSvg(bad).length, bad).toBeGreaterThan(0)
    expect(lintSvg(ok.replace('>x<', '>data: 2026-10-01<'))).toEqual([])
    for (const bad of [
      ok.replace('font-size="16"', 'font-size=\'10\''),
    ]) expect(lintSvg(bad).length, bad).toBeGreaterThan(0)
  })
})
