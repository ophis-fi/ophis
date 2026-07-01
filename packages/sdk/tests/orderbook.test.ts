import { describe, it, expect } from 'vitest';
import { getOphisOrderbookUrl, OPHIS_ORDERBOOK_URLS } from '@ophis/sdk';

describe('getOphisOrderbookUrl', () => {
  it('returns the self-hosted Ophis host for Optimism (10) + Unichain (130), NOT api.cow.fi', () => {
    expect(getOphisOrderbookUrl(10)).toBe('https://optimism-mainnet.ophis.fi');
    expect(getOphisOrderbookUrl(10)).not.toContain('api.cow.fi');
    expect(getOphisOrderbookUrl(130)).toBe('https://unichain-mainnet.ophis.fi');
    expect(getOphisOrderbookUrl(130)).not.toContain('api.cow.fi');
  });

  it('returns api.cow.fi hosts for CoW-hosted chains (Gnosis slug is "xdai")', () => {
    expect(getOphisOrderbookUrl(1)).toBe('https://api.cow.fi/mainnet');
    expect(getOphisOrderbookUrl(100)).toBe('https://api.cow.fi/xdai');
    expect(getOphisOrderbookUrl(8453)).toBe('https://api.cow.fi/base');
    expect(getOphisOrderbookUrl(42161)).toBe('https://api.cow.fi/arbitrum_one');
  });

  it('throws on an unsupported chainId rather than guessing a host', () => {
    expect(() => getOphisOrderbookUrl(12345)).toThrow(/no orderbook URL/);
  });

  it('throws on an invalid chainId (forgotten arg / NaN / non-positive)', () => {
    // @ts-expect-error testing the runtime guard with a missing arg
    expect(() => getOphisOrderbookUrl()).toThrow(/positive integer/);
    expect(() => getOphisOrderbookUrl(Number.NaN)).toThrow(/positive integer/);
    expect(() => getOphisOrderbookUrl(0)).toThrow(/positive integer/);
    expect(() => getOphisOrderbookUrl(-1)).toThrow(/positive integer/);
  });

  it('OPHIS_ORDERBOOK_URLS is frozen (cannot be mutated to retarget order posting)', () => {
    expect(Object.isFrozen(OPHIS_ORDERBOOK_URLS)).toBe(true);
  });
});
