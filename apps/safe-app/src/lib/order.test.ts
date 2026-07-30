import { describe, expect, it } from 'vitest';
import { MAX_SLIPPAGE_BPS } from '@ophis/safe-swap';
import { assembleOrder, type RequestedTrade } from './order';

const OWNER = '0x1111111111111111111111111111111111111111' as const;
const USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' as const; // OP USDC
const WETH = '0x4200000000000000000000000000000000000006' as const;
const APP_DATA_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

const REQ: RequestedTrade = { sellToken: USDC, buyToken: WETH, sellAmount: '1000000' };

// A CoW sell quote splits sellAmountBeforeFee into (net sellAmount, feeAmount).
const quote = (over: Record<string, unknown> = {}) => ({
  quote: {
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: '999000',
    feeAmount: '1000',
    buyAmount: '500000000000000000',
    validTo: 4_000_000_000, // far-future quote validTo, must be IGNORED (set locally)
    ...over,
  },
});

describe('assembleOrder (guard parity via @ophis/safe-swap)', () => {
  it('signs feeAmount "0" and the GROSS sellAmount (net + fee)', () => {
    const o = assembleOrder(OWNER, quote(), APP_DATA_HASH, REQ);
    expect(o.feeAmount).toBe('0');
    expect(o.sellAmount).toBe('1000000'); // 999000 + 1000 = the requested gross
  });

  it('pins the receiver to the Safe and sets validTo LOCALLY (never from the quote)', () => {
    const before = Math.floor(Date.now() / 1000);
    const o = assembleOrder(OWNER, quote(), APP_DATA_HASH, REQ);
    expect(o.receiver.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(o.validTo).toBeLessThan(4_000_000_000); // quote's far-future validTo ignored
    expect(o.validTo).toBeGreaterThanOrEqual(before + 29 * 60);
    expect(o.validTo).toBeLessThanOrEqual(before + 31 * 60);
    expect(o.partiallyFillable).toBe(false);
  });

  it('applies slippage to the buy floor and caps slippageBps', () => {
    const o = assembleOrder(OWNER, quote(), APP_DATA_HASH, REQ, 100);
    expect(o.buyAmount).toBe('495000000000000000'); // 0.5e18 * (1 - 1%)
    expect(() => assembleOrder(OWNER, quote(), APP_DATA_HASH, REQ, MAX_SLIPPAGE_BPS + 1)).toThrow(/out of range/);
  });

  it('binds the order to the REQUEST: substituted sell token throws', () => {
    const evil = quote({ sellToken: '0x2222222222222222222222222222222222222222' });
    expect(() => assembleOrder(OWNER, evil, APP_DATA_HASH, REQ)).toThrow(/sellToken .* != requested/);
  });

  it('binds the gross: a quote pulling more than requested throws', () => {
    const evil = quote({ sellAmount: '1999000' }); // gross 2_000_000 != requested 1_000_000
    expect(() => assembleOrder(OWNER, evil, APP_DATA_HASH, REQ)).toThrow(/quote gross .* != requested/);
  });

  it('rejects a zero-proceeds buy floor', () => {
    const evil = quote({ buyAmount: '0' });
    expect(() => assembleOrder(OWNER, evil, APP_DATA_HASH, REQ)).toThrow(/zero-proceeds/);
  });
});
