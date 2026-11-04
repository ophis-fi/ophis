import { afterEach, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ getBlock: vi.fn(), getBlockNumber: vi.fn(), getLogs: vi.fn() }));
vi.mock('../src/rpc/client.js', () => ({ getRpcClient: () => client }));
import { runSettleDecoder } from '../src/cow/onchain.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it.each([false, true])('reports the scanned safe-head timestamp, including fallback=%s', async (fallback) => {
  vi.stubEnv('SETTLE_DECODER_CHAINS', '100');
  vi.stubEnv('SETTLE_DECODER_DISCOVERY_ONLY', 'true');
  const timestamp = BigInt(Date.parse('2026-11-03T23:59:00Z') / 1_000);
  client.getBlock.mockImplementation(async (params) => {
    if (fallback && params.blockTag) throw new Error('finalized tag unsupported');
    return { number: 20n, timestamp };
  });
  client.getBlockNumber.mockResolvedValue(28n);
  client.getLogs.mockResolvedValue([]);
  const reportProgress = vi.fn(async () => {});
  const sql = vi.fn(async (strings: TemplateStringsArray) => strings.join('').includes('SELECT last_block') ? [{ last_block: '10' }] : []);
  await runSettleDecoder({ sql: sql as never, upsertTrades: async () => 0, reportProgress });
  expect(reportProgress).toHaveBeenCalledWith(100, true, new Date(Number(timestamp) * 1_000));
  expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 11n, toBlock: 20n }));
});
