import { describe, expect, it } from 'vitest'
import { PARAMS } from '../params'
import { holm, newcombe, phi, probit, wilson, zStar } from '../stats'
import { mulberry32 } from './fixtures'

const Z95 = probit(0.975)

describe('golden values', () => {
  it('probit matches reference quantiles to 1e-9', () => {
    expect(Z95).toBeCloseTo(1.959963984540054, 9)
    expect(probit(0.995)).toBeCloseTo(2.5758293035489004, 9)
    expect(probit(0.0125)).toBeCloseTo(-2.241402727604947, 9)
    expect(probit(1e-10)).toBeCloseTo(-6.361340902404056, 9)
    expect(probit(0.5)).toBe(0)
    for (const p of [1e-12, 0.001, 0.02, 0.3, 0.7, 0.98, 0.999]) expect(phi(probit(p))).toBeCloseTo(p, 12)
  })

  it('wilson and newcombe reproduce Newcombe (1998)', () => {
    const [l, u] = wilson(81, 263, Z95)
    expect(l).toBeCloseTo(0.2553, 4)
    expect(u).toBeCloseTo(0.3662, 4)
    expect(wilson(0, 10, Z95)[0]).toBe(0)
    expect(wilson(0, 10, Z95)[1]).toBeCloseTo(0.2775, 4)
    const [dl, du] = newcombe(56, 70, 48, 80, Z95)
    expect(dl).toBeCloseTo(0.0524, 4)
    expect(du).toBeCloseTo(0.3339, 4)
    const [el, eu] = newcombe(9, 10, 3, 10, Z95)
    expect(el).toBeCloseTo(0.1705, 4)
    expect(eu).toBeCloseTo(0.8090, 4)
  })
})

describe('Q7: interval bounds', () => {
  it('holds for random x ≤ n ≤ 10^4, including 0 and n', () => {
    const rand = mulberry32(7)
    const draw = () => {
      const n = 1 + Math.floor(rand() ** 3 * 10_000)
      const r = rand()
      return [r < 0.1 ? 0 : r < 0.2 ? n : Math.floor(rand() * (n + 1)), n] as const
    }
    for (let i = 0; i < 2000; i++) {
      const [x1, n1] = draw()
      const [x2, n2] = draw()
      const p = x1 / n1
      const [l, u] = wilson(x1, n1, Z95)
      expect(0 <= l && l <= p + 1e-12 && p <= u + 1e-12 && u <= 1).toBe(true)
      const d = p - x2 / n2
      const [dl, du] = newcombe(x1, n1, x2, n2, Z95)
      expect(dl <= d + 1e-12 && d <= du + 1e-12 && dl >= -1 - 1e-12 && du <= 1 + 1e-12).toBe(true)
      const [wl, wu] = newcombe(x1, n1, x2, n2, 2.5)
      expect(wl <= dl + 1e-12 && wu >= du - 1e-12).toBe(true)
      const [sl, su] = newcombe(x2, n2, x1, n1, Z95)
      expect(sl).toBeCloseTo(-du, 12)
      expect(su).toBeCloseTo(-dl, 12)
    }
  })

  it('z* is 0 for equal rates, bounded by zMax, and the interval at z* sits on 0', () => {
    expect(zStar(3, 10, 6, 20)).toBe(0)
    expect(zStar(1000, 1000, 0, 1000)).toBe(PARAMS.stats.zMax)
    const z = zStar(56, 70, 48, 80)
    expect(newcombe(56, 70, 48, 80, z)[0]).toBeCloseTo(0, 9)
    expect(z > Z95).toBe(true)
  })
})

describe('Q8: Holm', () => {
  it('rejects a prefix of the z-sorted list; ineligible additions change nothing; m=1 is the plain test', () => {
    const rand = mulberry32(8)
    for (let t = 0; t < 500; t++) {
      const items = Array.from({ length: 1 + Math.floor(rand() * 40) }, (_, i) => ({ key: `k${i}`, z: rand() < 0.3 ? 2 + rand() * 4 : rand() * 3 }))
      const rejected = holm(items)
      const sorted = [...items].sort((a, b) => b.z - a.z)
      const flags = sorted.map(it => rejected.has(it.key))
      expect(flags.indexOf(false) === -1 || flags.slice(flags.indexOf(false)).every(f => !f)).toBe(true)
    }
    expect(holm([{ key: 'a', z: Z95 }]).has('a')).toBe(true)
    expect(holm([{ key: 'a', z: Z95 - 1e-9 }]).has('a')).toBe(false)
  })

  it('breaks ties by input order', () => {
    const r = holm([{ key: 'a', z: 2.4 }, { key: 'b', z: 2.4 }])
    expect([...r]).toEqual(['a', 'b'])
    expect([...holm([{ key: 'a', z: 2.2 }, { key: 'b', z: 2.2 }])]).toEqual([])
  })
})
