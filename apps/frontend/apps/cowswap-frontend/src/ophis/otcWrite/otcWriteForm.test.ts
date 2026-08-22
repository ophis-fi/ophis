import { OTC_REVIEWED_TOKENS, parseOtcCreateDraft, parseOtcHumanAmount } from './otcWriteForm'

describe('OTC write form parsing', () => {
  it('parses human units with token-specific decimals', () => {
    expect(parseOtcHumanAmount('1.25', 18)).toBe(1_250_000_000_000_000_000n)
    expect(parseOtcHumanAmount('4000.50', 6)).toBe(4_000_500_000n)
  })

  it.each(['', '0', '-1', '+1', '1e3', '1.0000001'])('rejects invalid six-decimal amount %s', (value) => {
    expect(parseOtcHumanAmount(value, 6)).toBeNull()
  })

  it('rejects values that cannot fit into contract calldata without parsing unbounded input', () => {
    expect(parseOtcHumanAmount('1'.repeat(81), 0)).toBeNull()
    expect(parseOtcHumanAmount((2n ** 256n).toString(), 0)).toBeNull()
  })

  it('builds only a positive distinct reviewed pair', () => {
    const [weth, usdc] = OTC_REVIEWED_TOKENS
    expect(parseOtcCreateDraft({ tokenA: weth, amountA: '2', tokenB: usdc, amountB: '8000' })).toEqual({
      tokenA: weth.address,
      amountA: 2n * 10n ** 18n,
      tokenB: usdc.address,
      amountB: 8_000n * 10n ** 6n,
    })
    expect(parseOtcCreateDraft({ tokenA: weth, amountA: '2', tokenB: weth, amountB: '1' })).toBeNull()
    expect(
      parseOtcCreateDraft({
        tokenA: weth,
        amountA: '2',
        tokenB: { ...weth, address: weth.address.toLowerCase() as typeof weth.address },
        amountB: '1',
      }),
    ).toBeNull()
  })
})
