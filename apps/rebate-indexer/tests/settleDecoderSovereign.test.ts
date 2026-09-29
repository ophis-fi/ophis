import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { PublicClient } from 'viem';

// Mock the RPC client so we can inspect the getLogs call scanChain makes.
const getLogsSpy = vi.fn(async (_args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<never[]> => []);
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

const ENV = ['SETTLE_DECODER_CHAINS', 'SETTLE_DECODER_DISCOVERY_ONLY', 'SETTLE_SCAN_START_BLOCK_10', 'SETTLE_SCAN_START_BLOCK_130', 'SETTLE_SCAN_START_BLOCK_5042', 'SETTLE_SCAN_WINDOW'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  getLogsSpy.mockClear();
});

describe('settle decoder targets the sovereign settlement on sovereign chains', () => {
  it('scans Arc with 100-block windows, a bounded run and a resumable cursor', async () => {
    process.env.SETTLE_DECODER_CHAINS = '5042';
    process.env.SETTLE_DECODER_DISCOVERY_ONLY = 'true';
    delete process.env.SETTLE_SCAN_START_BLOCK_5042;
    vi.mocked(mockClient.getBlock).mockResolvedValueOnce({ number: 20000n } as never);
    let cursor: string | null = '99'; // reconciled snapshot, no archive-audit seed
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('INSERT INTO settle_scan_cursor')) cursor = values[1] as string;
      return cursor === null ? [] : [{ last_block: cursor }];
    });
    const upsertTrades = vi.fn(async () => 0);
    await runSettleDecoder({ sql: sql as never, upsertTrades });
    expect(getLogsSpy).toHaveBeenCalledTimes(100);
    expect(cursor).toBe('10099');
    for (const [args] of getLogsSpy.mock.calls) {
      expect(args.address).toBe('0x78799f98276efba1edeed32eae03a3fd8cdfec3a');
      expect(args.toBlock - args.fromBlock + 1n).toBeLessThanOrEqual(100n);
    }
    getLogsSpy.mockClear();
    vi.mocked(mockClient.getBlock).mockResolvedValueOnce({ number: 10150n } as never);
    await runSettleDecoder({ sql: sql as never, upsertTrades });
    expect(getLogsSpy).toHaveBeenCalledTimes(1);
    expect(getLogsSpy.mock.calls[0]![0].fromBlock).toBe(10100n);
    expect(cursor).toBe('10150');
    expect(upsertTrades).not.toHaveBeenCalled();
  });

  it('does not advance the Arc cursor after a failed RPC read', async () => {
    process.env.SETTLE_DECODER_CHAINS = '5042';
    process.env.SETTLE_DECODER_DISCOVERY_ONLY = 'true';
    process.env.SETTLE_SCAN_START_BLOCK_5042 = '100';
    getLogsSpy.mockRejectedValueOnce(new Error('RPC unavailable'));
    const sql = vi.fn(async () => []);
    await runSettleDecoder({ sql: sql as never, upsertTrades: async () => 0 });
    expect(sql).toHaveBeenCalledTimes(1); // cursor read only, no write
  });

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
