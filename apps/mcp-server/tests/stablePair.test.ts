import { describe, expect, it } from 'vitest';

import { resolveStablePair } from '../src/stablePair.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

describe('resolveStablePair', () => {
  it('classifies from the registry when the caller omits the assertion', () => {
    expect(resolveStablePair(1, USDC, USDT)).toBe(true);
    expect(resolveStablePair(1, WETH, USDC)).toBe(false);
  });

  it('accepts a matching assertion', () => {
    expect(resolveStablePair(1, USDC, USDT, true)).toBe(true);
    expect(resolveStablePair(1, WETH, USDC, false)).toBe(false);
  });

  it('rejects a volatile pair claiming the reduced stable policy', () => {
    expect(() => resolveStablePair(1, WETH, USDC, true)).toThrow(/disagrees/);
  });

  it('rejects a false assertion for a registered stable pair', () => {
    expect(() => resolveStablePair(1, USDC, USDT, false)).toThrow(/disagrees/);
  });
});
