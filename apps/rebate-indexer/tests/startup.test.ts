import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), price: vi.fn(), ready: vi.fn(), score: vi.fn(),
  repair: vi.fn(), archive: vi.fn(), rewards: vi.fn(), released: false,
}));
vi.mock('../src/db/migrate.js', () => ({ runMigrations: vi.fn() }));
vi.mock('../src/api.js', () => ({ startApi: vi.fn() }));
vi.mock('../src/cron.js', () => ({ startCron: vi.fn() }));
vi.mock('../src/fetcher.js', () => ({
  FETCHER_MAX_OWNERS_PER_RUN: 500,
  runFetcher: mocks.fetch,
  withPipelineLock: async (fn: () => Promise<void>) => {
    await fn();
    mocks.released = true;
    return true;
  },
}));
vi.mock('../src/pricer.js', () => ({ runPricer: mocks.price }));
vi.mock('../src/scorer.js', () => ({ runScorer: mocks.score }));
vi.mock('../src/defillamaBackfill.js', () => ({ completeDefiLlamaBackfillIfReady: mocks.ready }));
vi.mock('../src/repair/routerTrades.js', () => ({ repairRouterTrades: mocks.repair }));
vi.mock('../src/repair/defillamaSettlement.js', () => ({ repairDefiLlamaSettlementIdentity: mocks.archive }));
vi.mock('../src/tradeRewards/scheduler.js', () => ({
  startTradeRewardsScheduler: vi.fn(), runScheduledTradeRewards: mocks.rewards,
}));
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), fatal: vi.fn() } }));

describe('startup refresh', () => {
  it.each([false, true])('refreshes all batches without waiting for archive history (reporting ready: %s)', async (ready) => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.released = false;
    const started = Date.now();
    mocks.fetch.mockResolvedValueOnce({ owners: 500, inserted: 1 }).mockResolvedValue({ owners: 1, inserted: 0 });
    mocks.price.mockResolvedValue({ priced: 1, failed: 0 });
    mocks.ready.mockResolvedValue(ready);
    mocks.repair.mockResolvedValue({ scanned: 0, dequeued: 0 });
    mocks.archive.mockImplementation(() => new Promise(() => {}));
    mocks.rewards.mockImplementation(async () => { expect(mocks.released).toBe(true); });
    await import('../src/index.js');
    await vi.waitFor(() => expect(mocks.rewards).toHaveBeenCalledWith('startup'));
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const cutoff = mocks.fetch.mock.calls[0]![1]?.staleBefore;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(started);
    expect(mocks.fetch.mock.calls[1]![1]?.staleBefore).toBe(cutoff);
    expect(mocks.price).toHaveBeenCalledTimes(2);
    expect(mocks.score).toHaveBeenCalledTimes(1);
  });
});
