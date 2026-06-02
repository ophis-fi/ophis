import { describe, it, expect, vi, afterEach } from 'vitest';
import { getNonWethTokenBalances } from '../src/safe/balances.js';

// WETH on Gnosis (chain 100) — the token the pool read already covers.
const WETH = '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1';
const SAFE = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
const GNO = '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb';
const EURE = '0xcB444e90D8198415266c6a2724b7900fb12FC56E';

afterEach(() => vi.unstubAllGlobals());

function stubBalances(rows: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => rows })));
}

describe('getNonWethTokenBalances (Issue #360 stranded-fee safety net)', () => {
  it('flags non-WETH tokens with positive balance, skipping native + WETH + zero', async () => {
    stubBalances([
      { tokenAddress: null, balance: '5000000000000000000', token: null }, // native xDAI -> skipped
      { tokenAddress: WETH, balance: '1000000000000000000', token: { symbol: 'WETH' } }, // WETH -> skipped
      { tokenAddress: GNO, balance: '3000000000000000000', token: { symbol: 'GNO' } }, // flagged
      { tokenAddress: EURE, balance: '0', token: { symbol: 'EURe' } }, // zero -> skipped
    ]);
    const r = await getNonWethTokenBalances({ chainId: 100, safe: SAFE, weth: WETH });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symbol: 'GNO', balance: '3000000000000000000', tokenAddress: GNO });
  });

  it('parses the v2 paginated { results: [...] } envelope', async () => {
    stubBalances({
      count: 2,
      next: null,
      previous: null,
      results: [
        { tokenAddress: WETH, balance: '1000000000000000000', token: { symbol: 'WETH' } }, // skipped
        { tokenAddress: GNO, balance: '7000000000000000000', token: { symbol: 'GNO' } }, // flagged
      ],
    });
    const r = await getNonWethTokenBalances({ chainId: 100, safe: SAFE, weth: WETH });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symbol: 'GNO', tokenAddress: GNO });
  });

  it('is case-insensitive on the WETH address', async () => {
    stubBalances([{ tokenAddress: WETH.toLowerCase(), balance: '5', token: { symbol: 'WETH' } }]);
    expect(await getNonWethTokenBalances({ chainId: 100, safe: SAFE, weth: WETH })).toEqual([]);
  });

  it('returns [] when the Safe holds only WETH/native (no stranded fee value)', async () => {
    stubBalances([
      { tokenAddress: null, balance: '1', token: null },
      { tokenAddress: WETH, balance: '0', token: { symbol: 'WETH' } },
    ]);
    expect(await getNonWethTokenBalances({ chainId: 100, safe: SAFE, weth: WETH })).toEqual([]);
  });

  it('never throws on a network error — returns []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    expect(await getNonWethTokenBalances({ chainId: 100, safe: SAFE, weth: WETH })).toEqual([]);
  });

  it('returns [] on a non-OK HTTP response', async () => {
    stubBalances([], false);
    expect(await getNonWethTokenBalances({ chainId: 100, safe: SAFE, weth: WETH })).toEqual([]);
  });

  it('returns [] (skips the probe) for an unconfigured chain', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await getNonWethTokenBalances({ chainId: 999, safe: SAFE, weth: WETH })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled(); // unconfigured chain must not hit the network
  });
});
