// tests/scan/enrich.test.ts
import { describe, it, expect } from 'vitest';
import { tokenMeta, enrichSwap } from '../../src/scan/enrich.js';
import type { Swap } from '../../src/scan/types.js';

const WETH_OP = '0x4200000000000000000000000000000000000006' as const;

describe('tokenMeta', () => {
  it('uses the static fast-path without any RPC', async () => {
    const m = await tokenMeta(WETH_OP, null, new Map());
    expect(m).toEqual({ symbol: 'WETH', decimals: 18 });
  });
  it('falls back to on-chain reads and caches them', async () => {
    let calls = 0;
    const reader = { readContract: async ({ functionName }: any) => { calls++; return functionName === 'symbol' ? 'FOO' : 9; } };
    const cache = new Map();
    const a = '0x1111111111111111111111111111111111111111' as const;
    expect(await tokenMeta(a, reader, cache)).toEqual({ symbol: 'FOO', decimals: 9 });
    await tokenMeta(a, reader, cache); // cached
    expect(calls).toBe(2); // symbol + decimals once only
  });
  it('returns nulls when reads throw', async () => {
    const reader = { readContract: async () => { throw new Error('no code'); } };
    expect(await tokenMeta('0x2222222222222222222222222222222222222222', reader, new Map())).toEqual({ symbol: null, decimals: null });
  });
});

describe('enrichSwap', () => {
  const swap: Swap = {
    chainId: 10, chainName: 'optimism', tsUtc: '2026-06-18T20:36:27Z', orderUid: '0x56a0', txHash: '0xe315',
    owner: '0x0494', receiver: '0x0494',
    sell: { token: WETH_OP, symbol: null, decimals: null, amount: '20000000000000000' },
    buy: { token: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', symbol: null, decimals: null, amount: '34214818' },
    appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: null,
  };
  it('fills symbols/decimals and notionalUsd', async () => {
    const out = await enrichSwap(swap, { reader: null, metaCache: new Map(), priceFn: async () => 34.21 });
    expect(out.sell.symbol).toBe('WETH');
    expect(out.buy.symbol).toBe('USDT'); // static map for OP USDT
    expect(out.notionalUsd).toBe(34.21);
  });
  it('leaves notionalUsd null when pricing throws', async () => {
    const out = await enrichSwap(swap, { reader: null, metaCache: new Map(), priceFn: async () => { throw new Error('no liquidity'); } });
    expect(out.notionalUsd).toBeNull();
  });
});
