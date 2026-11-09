import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshIntervalMs, assessPublicDataFreshness, readPublicDataFreshness } from '../src/freshness.js';

afterEach(() => vi.unstubAllEnvs());

describe('assessPublicDataFreshness', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');

  it('is degraded until the first scorer publication completes', () => {
    expect(assessPublicDataFreshness(null, now)).toEqual({
      dataAsOf: null,
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'never_refreshed',
    });
  });

  it('is fresh through two configured refresh intervals', () => {
    const at = new Date(now - 2 * refreshIntervalMs()).toISOString();
    expect(assessPublicDataFreshness(at, now)).toMatchObject({
      dataAsOf: at,
      dataFresh: true,
      dataStatus: 'fresh',
      dataStaleReason: null,
    });
  });

  it('degrades immediately after the grace window', () => {
    const at = new Date(now - 2 * refreshIntervalMs() - 1).toISOString();
    expect(assessPublicDataFreshness(at, now)).toMatchObject({
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'refresh_overdue',
    });
  });

  it('uses the configured cadence instead of accepting a day-old hourly feed', () => {
    vi.stubEnv('REBATES_REFRESH_MINUTES', '60');
    const at = new Date(now - 3 * 60 * 60_000).toISOString();
    expect(assessPublicDataFreshness(at, now).dataFresh).toBe(false);
    vi.stubEnv('REBATES_REFRESH_MINUTES', '180');
    expect(assessPublicDataFreshness(at, now).dataFresh).toBe(true);
  });

  it('fails closed on a malformed database timestamp', () => {
    expect(assessPublicDataFreshness('not-a-date', now)).toMatchObject({
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'invalid_refresh_timestamp',
    });
  });
});


describe('ingestion coverage', () => {
  it('keeps a recent scorer publication degraded while Unichain is unavailable', async () => {
    const now = Date.now();
    const sql = vi.fn().mockResolvedValueOnce([{ refreshed_at: new Date(now).toISOString() }])
      .mockResolvedValueOnce([
        { chain_id: 1, total: 2, checked: 2, failed: 0, failed_wallets: 0, overdue: 0, last_success_at: new Date(now).toISOString(), unpriced: 0 },
        { chain_id: 130, total: 2, checked: 2, failed: 2, failed_wallets: 2, overdue: 2, last_success_at: null, unpriced: 0 },
      ]);
    const data = await readPublicDataFreshness(sql as unknown as import('postgres').Sql, now);
    expect(data).toMatchObject({ dataFresh: false, dataStatus: 'degraded', dataStaleReason: 'ingestion_incomplete' });
    expect(data.dataSources).toMatchObject([{ chainId: 1, status: 'fresh' }, { chainId: 130, status: 'unavailable' }]);
  });

  it('does not declare a newly enrolled, unattempted wallet covered', async () => {
    const sql = vi.fn().mockResolvedValueOnce([{ refreshed_at: new Date().toISOString() }])
      .mockResolvedValueOnce([{ chain_id: 1, total: 2, checked: 1, failed: 0, failed_wallets: 0, overdue: 1, last_success_at: new Date().toISOString(), unpriced: 0 }]);
    expect(await readPublicDataFreshness(sql as unknown as import('postgres').Sql)).toMatchObject({
      dataFresh: false, dataSources: [{ chainId: 1, status: 'pending' }],
    });
  });
});
