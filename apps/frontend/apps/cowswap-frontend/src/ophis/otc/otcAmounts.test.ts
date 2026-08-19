import { computeOtcRate, formatOtcAmount } from './otcAmounts'

describe('formatOtcAmount', () => {
  it('renders exact token amounts without float rounding', () => {
    expect(formatOtcAmount(1_000_000_000_000_000_000n, 18)).toBe('1')
    expect(formatOtcAmount(1n, 18)).toBe('0.000000000000000001')
    expect(formatOtcAmount(1_500_000n, 6)).toBe('1.5')
    expect(formatOtcAmount(0n, 6)).toBe('0')
    expect(formatOtcAmount(100_000_000_000_000_000_000n, 18)).toBe('100')
    expect(formatOtcAmount(4_000_123_456n, 6)).toBe('4000.123456')
    expect(formatOtcAmount(123n, 0)).toBe('123')
  })
})

describe('computeOtcRate', () => {
  it('computes the pair rate for the recorded order 143 (100 ZAMM -> 1 WETH)', () => {
    const rate = computeOtcRate(100_000_000_000_000_000_000n, 18, 1_000_000_000_000_000_000n, 18)
    expect(rate).toEqual({ rate: '0.01', inverseRate: '100' })
  })

  it('handles mixed decimals (1 WETH -> 4000 USDC)', () => {
    const rate = computeOtcRate(1_000_000_000_000_000_000n, 18, 4_000_000_000n, 6)
    expect(rate).toEqual({ rate: '4000', inverseRate: '0.00025' })
  })

  it('keeps sub-unit precision without floats', () => {
    // 3 units -> 1 unit: rate is a repeating decimal, truncated not rounded up
    const rate = computeOtcRate(3_000_000n, 6, 1_000_000n, 6)
    expect(rate?.rate).toBe('0.33333333')
    expect(rate?.inverseRate).toBe('3')
  })

  it('returns null when either amount is zero', () => {
    expect(computeOtcRate(0n, 18, 1n, 18)).toBeNull()
    expect(computeOtcRate(1n, 18, 0n, 18)).toBeNull()
  })

  it('returns null instead of rendering a truncated-to-zero rate', () => {
    expect(computeOtcRate(10n ** 30n, 18, 1n, 18)).toBeNull()
  })
})
