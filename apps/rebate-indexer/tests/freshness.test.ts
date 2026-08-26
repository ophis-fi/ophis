import { describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MAX_AGE_MS, assessPublicDataFreshness } from '../src/freshness.js';

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

  it('is fresh through the 26-hour boundary', () => {
    const at = new Date(now - PUBLIC_DATA_MAX_AGE_MS).toISOString();
    expect(assessPublicDataFreshness(at, now)).toMatchObject({
      dataAsOf: at,
      dataFresh: true,
      dataStatus: 'fresh',
      dataStaleReason: null,
    });
  });

  it('degrades immediately after the grace window', () => {
    const at = new Date(now - PUBLIC_DATA_MAX_AGE_MS - 1).toISOString();
    expect(assessPublicDataFreshness(at, now)).toMatchObject({
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'refresh_overdue',
    });
  });

  it('fails closed on a malformed database timestamp', () => {
    expect(assessPublicDataFreshness('not-a-date', now)).toMatchObject({
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'invalid_refresh_timestamp',
    });
  });
});
