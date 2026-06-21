import { describe, it, expect } from 'vitest';
import { CACHED_CLASSES } from '../../src/scan/types.js';
import type { Swap, Coverage } from '../../src/scan/types.js';

describe('scan types', () => {
  it('exports the cache-class tuple at runtime (module actually loads)', () => {
    expect([...CACHED_CLASSES]).toEqual(['ophis', 'greg', 'none']);
  });

  it('Swap and Coverage are usable shapes', () => {
    const s: Swap = {
      chainId: 1, chainName: 'ethereum', tsUtc: '2026-06-18T20:43:11Z',
      orderUid: '0xda3c', txHash: '0x5348', owner: '0xba3c', receiver: '0x0494',
      sell: { token: '0xc02a', symbol: 'WETH', decimals: 18, amount: '41000000000000000' },
      buy: { token: '0xdac1', symbol: 'USDT', decimals: 6, amount: '69927413' },
      appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: 69.93,
    };
    const c: Coverage = { chainId: 1, chainName: 'ethereum', status: 'ok', fillsScanned: 2880, ophisFound: 1, unresolved: 0 };
    expect(s.appCode).toBe('ophis');
    expect(c.status).toBe('ok');
  });
});
