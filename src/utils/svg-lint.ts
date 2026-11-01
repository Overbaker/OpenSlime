export const SANS_STACK = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, \'Segoe UI\', Helvetica, Arial, sans-serif'
export const MONO_STACK = 'ui-monospace, SFMono-Regular, \'SF Mono\', Menlo, Consolas, \'Liberation Mono\', monospace'

/**
 * GitHub-safe static SVG rules shared by the README diagrams and `osm ledger render`. Returns the problems found;
 * an empty list means the SVG passes.
 */
export function lintSvg(s: string): string[] {
  const problems: string[] = []
  if (/<script|foreignObject|@import|\bon[a-z]+\s*=/i.test(s)) problems.push('active content (script, foreignObject, @import or on*=)')
  if (/<style|\sstyle\s*=|<!DOCTYPE|<!ENTITY/i.test(s)) problems.push('style block, style attribute or DTD')
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(s)) problems.push('href to anything but a local #id')
  if (/https?:\/\/|javascript:|data:[a-z]+\/|=\s*["']\/\//i.test(s.replaceAll('http://www.w3.org/2000/svg', ''))) problems.push('URL other than the SVG namespace')
  if (!/viewBox="0 0 960 \d+"/.test(s)) problems.push('viewBox must be "0 0 960 H"')
  if (!s.includes('role="img"')) problems.push('missing role="img"')
  if (!/<title>[^<]{20,}<\/title>/.test(s)) problems.push('title shorter than 20 characters')
  for (const m of s.matchAll(/font-size\s*=\s*["']([^"']*)["']/g)) {
    if (!(Number(m[1]) >= 16)) problems.push(`font-size ${m[1]} below 16 or not a number`)
  }
  for (const m of s.matchAll(/font-family\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const family = (m[1] ?? m[2]).replaceAll('&apos;', '\'').replaceAll('&quot;', '"')
    if (family !== SANS_STACK && family !== MONO_STACK) problems.push(`font-family not the system stack: ${family}`)
  }
  return problems
}
