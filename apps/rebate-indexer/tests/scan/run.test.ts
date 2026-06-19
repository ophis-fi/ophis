import { describe, it, expect } from 'vitest';
import { runScan } from '../../src/scan/run.js';
import type { ChainConfig, ScanResult, Swap } from '../../src/scan/types.js';

const cfg = (id: number, name: string): ChainConfig => ({ chainId: id, name, kind: 'rpc', alchemySubdomain: 'x' });
const swap = (chain: string, ts: string): Swap => ({
  chainId: 1, chainName: chain, tsUtc: ts, orderUid: '0x', txHash: null, owner: '0x', receiver: '0x',
  sell: { token: '0x', symbol: null, decimals: null, amount: '1' },
  buy: { token: '0x', symbol: null, decimals: null, amount: '1' },
  appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: null,
});

describe('runScan', () => {
  it('merges chains, sorts by tsUtc desc, isolates failures', async () => {
    const results: Record<string, ScanResult> = {
      a: { swaps: [swap('a', '2026-06-18T10:00:00Z')], coverage: { chainId: 1, chainName: 'a', status: 'ok', fillsScanned: 1, ophisFound: 1, unresolved: 0 } },
      b: { swaps: [swap('b', '2026-06-18T20:00:00Z')], coverage: { chainId: 2, chainName: 'b', status: 'ok', fillsScanned: 1, ophisFound: 1, unresolved: 0 } },
    };
    const out = await runScan(
      { sinceSec: 48 * 3600, chains: [cfg(1, 'a'), cfg(2, 'b')], nowSec: 1_800_000_000 },
      { scanChain: async (c) => results[c.name]!, enrich: async (s) => s },
    );
    expect(out.swaps.map((s) => s.chainName)).toEqual(['b', 'a']); // newest first
    expect(out.coverage).toHaveLength(2);
  });
  it('turns a thrown scanChain into a degraded coverage row', async () => {
    const out = await runScan(
      { sinceSec: 3600, chains: [cfg(1, 'a')], nowSec: 1_800_000_000 },
      { scanChain: async () => { throw new Error('boom'); }, enrich: async (s) => s },
    );
    expect(out.swaps).toHaveLength(0);
    expect(out.coverage[0]!.status).toBe('degraded');
    expect(out.coverage[0]!.error).toContain('boom');
  });
});
