import { describe, expect, it } from 'vitest';
import { isOphisStablePair } from '../src/stablecoins.js';

describe('isOphisStablePair', () => {
  it('recognizes registered stable pairs case-insensitively', () => {
    expect(
      isOphisStablePair(
        1,
        '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        '0xdac17f958d2ee523a2206206994597c13d831ec7',
      ),
    ).toBe(true);
  });

  it('includes Robinhood USDG', () => {
    const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    expect(isOphisStablePair(4663, usdg, usdg)).toBe(true);
  });

  it('fails closed for volatile tokens and unknown chains', () => {
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    expect(isOphisStablePair(1, weth, usdc)).toBe(false);
    expect(isOphisStablePair(999999, usdc, usdc)).toBe(false);
  });
});
