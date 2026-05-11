import { describe, it, expect } from 'vitest';
import { computeTradeUsd } from '../src/pricer.js';

describe('computeTradeUsd', () => {
  it('values a trade by sell-side USD when sellToken→USDC quote is provided', () => {
    // Sold 1 WETH, buyToken irrelevant; quote says 1 WETH = 2500 USDC (sellAmount 1e18 → buyAmount 2.5e9 USDC@6)
    const usd = computeTradeUsd({
      sellAmount: 10n ** 18n,
      sellTokenDecimals: 18,
      quoteSellAmount: 10n ** 18n,
      quoteBuyAmount: 2_500n * 10n ** 6n,
      quoteBuyTokenDecimals: 6,
    });
    expect(usd).toBeCloseTo(2_500, 2);
  });

  it('rounds to 4 decimal places (matches NUMERIC(20,4) column)', () => {
    const usd = computeTradeUsd({
      sellAmount: 123_456_789n,
      sellTokenDecimals: 6,                                            // USDC
      quoteSellAmount: 1_000_000n,                                     // 1 USDC
      quoteBuyAmount: 1_000_000n,                                      // 1 USDC (self-quote)
      quoteBuyTokenDecimals: 6,
    });
    expect(usd).toBeCloseTo(123.4568, 4);
  });

  it('returns 0 for zero sellAmount', () => {
    expect(computeTradeUsd({
      sellAmount: 0n,
      sellTokenDecimals: 18,
      quoteSellAmount: 10n ** 18n,
      quoteBuyAmount: 2_500n * 10n ** 6n,
      quoteBuyTokenDecimals: 6,
    })).toBe(0);
  });

  it('throws if quoteSellAmount is zero (degenerate quote)', () => {
    expect(() => computeTradeUsd({
      sellAmount: 10n ** 18n,
      sellTokenDecimals: 18,
      quoteSellAmount: 0n,
      quoteBuyAmount: 1n,
      quoteBuyTokenDecimals: 6,
    })).toThrow(/quoteSellAmount/);
  });
});
