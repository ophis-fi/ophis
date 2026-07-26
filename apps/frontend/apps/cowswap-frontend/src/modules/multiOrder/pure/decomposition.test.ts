import { decomposeBasket, splitAmountExact, totalSellAtoms, BasketComposition } from './decomposition'

const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n)

describe('splitAmountExact', () => {
  it('splits evenly when it divides cleanly', () => {
    expect(splitAmountExact(100n, [1n, 1n, 1n, 1n])).toEqual([25n, 25n, 25n, 25n])
  })

  it('conserves every atom on an uneven split (largest-remainder dust to earliest ties)', () => {
    // 100 / 3 = 33 r 1. Equal weights => equal fractions => the single leftover
    // atom goes to the lowest index.
    const parts = splitAmountExact(100n, [1n, 1n, 1n])
    expect(parts).toEqual([34n, 33n, 33n])
    expect(sum(parts)).toBe(100n)
  })

  it('hands leftover atoms to the LARGEST fractional remainders first', () => {
    // total 10, weights [1,1,1] over W=3: floors [3,3,3]=9, remainder 1, equal
    // fractions -> index 0. total 11 -> floors [3,3,3]=9, remainder 2 -> indices 0,1.
    expect(splitAmountExact(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n])
    expect(splitAmountExact(11n, [1n, 1n, 1n])).toEqual([4n, 4n, 3n])
  })

  it('weights the split and still conserves atoms', () => {
    // 100 across [1,3]: floors [25,75], exact.
    expect(splitAmountExact(100n, [1n, 3n])).toEqual([25n, 75n])
    // 100 across [1,1,1,1,1,1] (6 buys): 16 r 4 -> first four get +1.
    const six = splitAmountExact(100n, [1n, 1n, 1n, 1n, 1n, 1n])
    expect(six).toEqual([17n, 17n, 17n, 17n, 16n, 16n])
    expect(sum(six)).toBe(100n)
  })

  it('gives a single weight the whole total (1-leg split)', () => {
    expect(splitAmountExact(999n, [5n])).toEqual([999n])
  })

  it('never assigns leftover atoms to a zero-weight part', () => {
    // total 10, weights [0, 1, 1]: W=2, floors [0,5,5]=10, remainder 0.
    expect(splitAmountExact(10n, [0n, 1n, 1n])).toEqual([0n, 5n, 5n])
    // total 11, weights [0, 1, 1]: floors [0,5,5]=10, remainder 1 -> largest frac
    // among positive parts (index 1), zero-weight index 0 stays 0.
    const parts = splitAmountExact(11n, [0n, 1n, 1n])
    expect(parts[0]).toBe(0n)
    expect(sum(parts)).toBe(11n)
  })

  it('handles a zero total (all zeros)', () => {
    expect(splitAmountExact(0n, [1n, 2n, 3n])).toEqual([0n, 0n, 0n])
  })

  it('handles very large (near-uint256) totals exactly', () => {
    const big = (1n << 255n) + 7n // odd, forces a remainder on a 2-way split
    const parts = splitAmountExact(big, [1n, 1n])
    expect(sum(parts)).toBe(big)
    expect(parts[0] - parts[1]).toBe(1n) // leftover atom to the lower index
  })

  it('rejects undefined splits', () => {
    expect(() => splitAmountExact(10n, [])).toThrow()
    expect(() => splitAmountExact(10n, [0n, 0n])).toThrow() // zero weight sum
    expect(() => splitAmountExact(-1n, [1n])).toThrow()
    expect(() => splitAmountExact(10n, [1n, -1n])).toThrow()
  })

  it('property: parts always sum to total across a sweep of totals and weightings', () => {
    const weightings: bigint[][] = [
      [1n],
      [1n, 1n],
      [1n, 2n],
      [3n, 5n, 7n],
      [1n, 1n, 1n, 1n, 1n, 1n],
      [10n, 1n, 1n],
    ]
    for (let total = 0n; total <= 250n; total++) {
      for (const w of weightings) {
        const parts = splitAmountExact(total, w)
        expect(sum(parts)).toBe(total)
        expect(parts.every((p) => p >= 0n)).toBe(true)
      }
    }
  })
})

describe('decomposeBasket', () => {
  const A = '0x000000000000000000000000000000000000000a'
  const B = '0x000000000000000000000000000000000000000b'
  const C = '0x000000000000000000000000000000000000000c'
  const D = '0x000000000000000000000000000000000000000d'
  const E = '0x000000000000000000000000000000000000000e'
  const F = '0x000000000000000000000000000000000000000f'
  const G = '0x0000000000000000000000000000000000000010'

  it('1-leg: a single sell into a single buy', () => {
    const legs = decomposeBasket({ sells: [{ token: A, amount: '1000' }], buys: [{ token: B, weight: 1n }] })
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({ sellToken: A, buyToken: B, sellAmount: 1000n })
  })

  it('fan-out: one sell split across many buys, atoms conserved', () => {
    const comp: BasketComposition = {
      sells: [{ token: A, amount: '100' }],
      buys: [
        { token: B, weight: 1n },
        { token: C, weight: 1n },
        { token: D, weight: 1n },
      ],
    }
    const legs = decomposeBasket(comp)
    expect(legs).toHaveLength(3)
    expect(sum(legs.map((l) => l.sellAmount))).toBe(100n)
    expect(legs.map((l) => l.sellAmount)).toEqual([34n, 33n, 33n]) // dust to first
    expect(sum(legs.map((l) => l.sellAmount))).toBe(totalSellAtoms(comp))
  })

  it('fan-in: many sells into one buy (each leg full amount)', () => {
    const legs = decomposeBasket({
      sells: [
        { token: A, amount: '10' },
        { token: C, amount: '20' },
        { token: D, amount: '30' },
      ],
      buys: [{ token: B, weight: 1n }],
    })
    expect(legs).toHaveLength(3)
    expect(legs.map((l) => l.sellAmount)).toEqual([10n, 20n, 30n])
  })

  it('6-leg grid: 2 sells x 3 buys = 6 legs, per-sell atoms conserved', () => {
    const comp: BasketComposition = {
      sells: [
        { token: A, amount: '100' },
        { token: E, amount: '77' },
      ],
      buys: [
        { token: B, weight: 1n },
        { token: C, weight: 1n },
        { token: D, weight: 1n },
      ],
    }
    const legs = decomposeBasket(comp)
    expect(legs).toHaveLength(6)
    // per-sell conservation
    const sellA = legs.filter((l) => l.sellToken === A)
    const sellE = legs.filter((l) => l.sellToken === E)
    expect(sum(sellA.map((l) => l.sellAmount))).toBe(100n)
    expect(sum(sellE.map((l) => l.sellAmount))).toBe(77n)
    // global sum-equals-total invariant
    expect(sum(legs.map((l) => l.sellAmount))).toBe(totalSellAtoms(comp))
  })

  it('6-leg fan-out: one sell across the max 6 buys', () => {
    const legs = decomposeBasket({
      sells: [{ token: A, amount: '100' }],
      buys: [B, C, D, E, F, G].map((token) => ({ token, weight: 1n })),
    })
    expect(legs).toHaveLength(6)
    expect(sum(legs.map((l) => l.sellAmount))).toBe(100n)
  })

  it('drops zero-amount legs from a lopsided split (dust cannot fund every buy)', () => {
    // 1 atom across 3 equal buys -> [1,0,0]; only the funded leg survives.
    const legs = decomposeBasket({
      sells: [{ token: A, amount: '1' }],
      buys: [
        { token: B, weight: 1n },
        { token: C, weight: 1n },
        { token: D, weight: 1n },
      ],
    })
    expect(legs).toHaveLength(1)
    expect(legs[0].sellAmount).toBe(1n)
  })

  it('enforces the 6-leg cap (a composition needing >6 legs throws)', () => {
    // 3 sells x 3 buys = 9 legs > 6.
    expect(() =>
      decomposeBasket({
        sells: [
          { token: A, amount: '100' },
          { token: E, amount: '100' },
          { token: F, amount: '100' },
        ],
        buys: [
          { token: B, weight: 1n },
          { token: C, weight: 1n },
          { token: D, weight: 1n },
        ],
      }),
    ).toThrow(/6-leg cap/)
  })

  it('enforces the 6x6 product caps', () => {
    const sevenSells = Array.from({ length: 7 }, (_v, i) => ({ token: `0x${(i + 1).toString(16).padStart(40, '0')}`, amount: '10' }))
    expect(() => decomposeBasket({ sells: sevenSells, buys: [{ token: B, weight: 1n }] })).toThrow(/sells must be 1\.\.6/)
    const sevenBuys = Array.from({ length: 7 }, (_v, i) => ({ token: `0x${(i + 20).toString(16).padStart(40, '0')}`, weight: 1n }))
    expect(() => decomposeBasket({ sells: [{ token: A, amount: '10' }], buys: sevenBuys })).toThrow(/buys must be 1\.\.6/)
  })

  it('rejects a sell token that is also a buy token (self-swap)', () => {
    expect(() =>
      decomposeBasket({ sells: [{ token: A, amount: '10' }], buys: [{ token: A, weight: 1n }] }),
    ).toThrow(/also appears as a buy token/)
  })

  it('rejects a duplicate SELL token (case-insensitive)', () => {
    expect(() =>
      decomposeBasket({
        sells: [
          { token: A, amount: '10' },
          { token: A.toUpperCase(), amount: '20' }, // same token, mixed case
        ],
        buys: [{ token: B, weight: 1n }],
      }),
    ).toThrow(/duplicate sell token/)
  })

  it('rejects a duplicate BUY token (case-insensitive)', () => {
    expect(() =>
      decomposeBasket({
        sells: [{ token: A, amount: '10' }],
        buys: [
          { token: B, weight: 1n },
          { token: B.toUpperCase(), weight: 1n },
        ],
      }),
    ).toThrow(/duplicate buy token/)
  })

  it('rejects unsignable sell amounts', () => {
    expect(() => decomposeBasket({ sells: [{ token: A, amount: '0' }], buys: [{ token: B, weight: 1n }] })).toThrow()
    expect(() => decomposeBasket({ sells: [{ token: A, amount: '-5' }], buys: [{ token: B, weight: 1n }] })).toThrow()
    expect(() => decomposeBasket({ sells: [{ token: A, amount: '1.5' }], buys: [{ token: B, weight: 1n }] })).toThrow()
  })
})
