import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { PublicClient } from 'viem';

// Mock the RPC client so we can inspect the getLogs call scanChain makes.
const getLogsSpy = vi.fn(async (_args: { address: `0x${string}` }): Promise<never[]> => []);
const mockClient = {
  getBlock: vi.fn(async (a: { blockTag?: string }) =>
    a?.blockTag === 'finalized' ? { number: 200n } : { timestamp: 1_700_000_000n },
  ),
  getBlockNumber: vi.fn(async () => 200n),
  getLogs: getLogsSpy,
} as unknown as PublicClient;

vi.mock('../src/rpc/client.js', () => ({
  getRpcClient: () => mockClient,
  _resetRpcClients: () => {},
}));

const { runSettleDecoder } = await import('../src/cow/onchain.js');
const { settlementAddressFor } = await import('../src/cow/settleAbi.js');

const ENV = ['SETTLE_DECODER_CHAINS', 'SETTLE_DECODER_DISCOVERY_ONLY', 'SETTLE_SCAN_START_BLOCK_10', 'SETTLE_SCAN_START_BLOCK_130', 'SETTLE_SCAN_WINDOW'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  getLogsSpy.mockClear();
});

describe('settle decoder targets the sovereign settlement on sovereign chains', () => {
  it('scans the sovereign Optimism GPv2Settlement, NOT the canonical 0x9008D19f address', async () => {
    process.env.SETTLE_DECODER_CHAINS = '10';
    process.env.SETTLE_DECODER_DISCOVERY_ONLY = 'true';
    process.env.SETTLE_SCAN_START_BLOCK_10 = '100';
    process.env.SETTLE_SCAN_WINDOW = '1000';
    const sql = (async () => []) as never; // no cursor row -> seed from SETTLE_SCAN_START_BLOCK_10
    const upsertTrades = vi.fn(async () => 0);

    await runSettleDecoder({ sql, upsertTrades });

    expect(getLogsSpy).toHaveBeenCalled();
    const arg = getLogsSpy.mock.calls[0]![0];
    expect(arg.address.toLowerCase()).toBe(settlementAddressFor(10).toLowerCase());
    expect(arg.address.toLowerCase()).toBe('0x310784c7fce12d578da6f53460777bac9718b859');
  });

  it('scans the sovereign Unichain GPv2Settlement for chain 130', async () => {
    process.env.SETTLE_DECODER_CHAINS = '130';
    process.env.SETTLE_DECODER_DISCOVERY_ONLY = 'true';
    process.env.SETTLE_SCAN_START_BLOCK_130 = '100';
    process.env.SETTLE_SCAN_WINDOW = '1000';
    const sql = (async () => []) as never;
    const upsertTrades = vi.fn(async () => 0);

    await runSettleDecoder({ sql, upsertTrades });

    const arg = getLogsSpy.mock.calls[0]![0];
    expect(arg.address.toLowerCase()).toBe('0x108a678716e5e1776036ef044cab7064226f714e');
  });
});
