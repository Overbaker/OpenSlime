import { createHash } from 'node:crypto'

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** JSON with object keys in code-point order, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export function sha256Hex(data: string | Buffer, length = 64): string {
  return createHash('sha256').update(data).digest('hex').slice(0, length)
}
