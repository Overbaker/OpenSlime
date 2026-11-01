import { PARAMS } from './params'

export type Interval = [number, number]

/** Wilson score interval for x successes out of n at z. */
export function wilson(x: number, n: number, z: number): Interval {
  if (n <= 0) return [0, 1]
  const p = x / n
  const z2 = z * z
  const den = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / den
  const half = (z / den) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

/** Newcombe's hybrid score interval (method 10) for p1 − p2, built from Wilson intervals. */
export function newcombe(x1: number, n1: number, x2: number, n2: number, z: number): Interval {
  const p1 = x1 / n1
  const p2 = x2 / n2
  const [l1, u1] = wilson(x1, n1, z)
  const [l2, u2] = wilson(x2, n2, z)
  const d = p1 - p2
  return [d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)]
}

/**
 * The largest z in [0, zMax] at which the difference interval still excludes 0 (the interval widens with z).
 * 0 when the point difference is 0; zMax when even zMax excludes 0.
 */
export function zStar(x1: number, n1: number, x2: number, n2: number): number {
  const { zMax, bisectIters } = PARAMS.stats
  if (x1 / n1 === x2 / n2) return 0
  const excludes = (z: number) => {
    const [l, u] = newcombe(x1, n1, x2, n2, z)
    return l > 0 || u < 0
  }
  if (excludes(zMax)) return zMax
  let lo = 0
  let hi = zMax
  for (let i = 0; i < bisectIters; i++) {
    const mid = (lo + hi) / 2
    if (excludes(mid)) lo = mid
    else hi = mid
  }
  return lo
}

// Acklam's rational approximation of the inverse standard normal CDF (relative error < 1.15e-9 before refinement).
const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]

/** erfc to double precision: a positive-term series below 3, a Lentz continued fraction above. */
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x)
  if (x < 3) {
    let term = x
    let sum = x
    for (let n = 1; n < 200 && term > sum * 1e-17; n++) {
      term *= 2 * x * x / (2 * n + 1)
      sum += term
    }
    return 1 - 2 / Math.sqrt(Math.PI) * Math.exp(-x * x) * sum
  }
  const tiny = 1e-300
  let f = x
  let c = x
  let d = 0
  for (let n = 1; n < 500; n++) {
    const a = n / 2
    d = x + a * d
    d = Math.abs(d) < tiny ? tiny : d
    c = x + a / c
    c = Math.abs(c) < tiny ? tiny : c
    d = 1 / d
    const delta = c * d
    f *= delta
    if (Math.abs(delta - 1) < 1e-16) break
  }
  return Math.exp(-x * x) / Math.sqrt(Math.PI) / f
}

/** Standard normal CDF. */
export function phi(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2)
}

function acklam(p: number): number {
  const lowTail = 0.02425
  if (p < lowTail) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
  }
  if (p > 1 - lowTail) return -acklam(1 - p)
  const q = p - 0.5
  const r = q * q
  return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
}

/** Inverse standard normal CDF: Acklam's approximation refined by one Halley step. */
export function probit(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY
  if (p >= 1) return Number.POSITIVE_INFINITY
  if (p > 0.5) return -probit(1 - p)
  const x = acklam(p)
  const u = (phi(x) - p) * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2)
  return x - u / (1 + x * u / 2)
}

export interface HolmItem {
  key: string
  z: number
}

/**
 * Holm step-down at level alpha over items already in tie-break order. Returns the keys rejected, which always
 * form a prefix of the z-descending order.
 */
export function holm(items: HolmItem[], alpha: number = PARAMS.stats.alpha): Set<string> {
  const sorted = items.map((it, i) => ({ ...it, i })).sort((a, b) => b.z - a.z || a.i - b.i)
  const m = sorted.length
  const rejected = new Set<string>()
  for (let k = 1; k <= m; k++) {
    const crit = probit(1 - alpha / (2 * (m - k + 1)))
    if (sorted[k - 1].z >= crit) rejected.add(sorted[k - 1].key)
    else break
  }
  return rejected
}
