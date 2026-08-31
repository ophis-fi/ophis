import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// cron.ts transitively imports db/index.ts, which THROWS at import time unless
// DATABASE_URL is set. postgres.js connects LAZILY (on first query), so a dummy URL
// resolves the module graph without ever opening a socket. Set it, then dynamic-import
// so the resolver can be unit-tested in isolation, mirroring the sibling flag tests
// (affiliate/payout.test.ts, ownFee tests).
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/rebates_test';

describe('resolveBatcherProposeEnabled — default-ON, fail-loud money-path flag', () => {
  let resolveBatcherProposeEnabled: () => boolean;
  beforeAll(async () => {
    ({ resolveBatcherProposeEnabled } = await import('../src/cron.js'));
  });
  afterEach(() => {
    delete process.env.BATCHER_PROPOSE_ENABLED;
  });

  it('defaults ON when unset or empty (byte-identical to prior behavior)', () => {
    delete process.env.BATCHER_PROPOSE_ENABLED;
    expect(resolveBatcherProposeEnabled()).toBe(true);
    process.env.BATCHER_PROPOSE_ENABLED = '';
    expect(resolveBatcherProposeEnabled()).toBe(true);
  });

  it("treats 'true'/'1' as ON", () => {
    process.env.BATCHER_PROPOSE_ENABLED = 'true';
    expect(resolveBatcherProposeEnabled()).toBe(true);
    process.env.BATCHER_PROPOSE_ENABLED = '1';
    expect(resolveBatcherProposeEnabled()).toBe(true);
  });

  it("treats only exact 'false'/'0' as OFF (dry-run)", () => {
    process.env.BATCHER_PROPOSE_ENABLED = 'false';
    expect(resolveBatcherProposeEnabled()).toBe(false);
    process.env.BATCHER_PROPOSE_ENABLED = '0';
    expect(resolveBatcherProposeEnabled()).toBe(false);
  });

  it('THROWS (fail-loud, never fail-OPEN) on an ambiguous value', () => {
    // The old `!== 'false'` parse would have silently PROPOSED real money for every
    // one of these — the exact fail-open bug this resolver closes.
    for (const v of ['False', 'FALSE', 'no', 'off', 'yes', 'garbage', '2', 'disabled']) {
      process.env.BATCHER_PROPOSE_ENABLED = v;
      expect(() => resolveBatcherProposeEnabled(), `value "${v}" must throw`).toThrow(/BATCHER_PROPOSE_ENABLED/);
    }
  });
});

describe('lastNightlyBoundary — the durable-record scheduler replacing node-cron', () => {
  let lastNightlyBoundary: (nowMs: number) => Date;
  beforeAll(async () => {
    ({ lastNightlyBoundary } = await import('../src/cron.js'));
  });

  // node-cron@4 arms a timer for the target instant and SKIPS the job if the timer
  // lands outside the target second, logging "missed execution". On Cadia
  // (Windows 11 + WSL2, which suspends) that skipped every night: measured on the
  // host 2026-08-31, `grep -c 'pipeline start'` was 0 across 35h of uptime. The
  // replacement asks "is a run due?" from pipeline_runs instead of trusting a timer,
  // so being late is survivable and being suspended is survivable.

  it('returns the most recent 02:00 UTC boundary at or before now', () => {
    expect(lastNightlyBoundary(Date.parse('2026-08-31T19:00:00Z')).toISOString())
      .toBe('2026-08-31T02:00:00.000Z');
  });

  it('rolls back to the PREVIOUS day just before 02:00', () => {
    expect(lastNightlyBoundary(Date.parse('2026-08-31T01:59:59Z')).toISOString())
      .toBe('2026-08-30T02:00:00.000Z');
  });

  it('is inclusive exactly at the boundary', () => {
    expect(lastNightlyBoundary(Date.parse('2026-08-31T02:00:00Z')).toISOString())
      .toBe('2026-08-31T02:00:00.000Z');
  });

  it('still names a due boundary after a multi-day suspend — the case node-cron dropped', () => {
    // Host asleep across 2026-08-29..08-31; on resume the poll must still see a run as due.
    expect(lastNightlyBoundary(Date.parse('2026-08-31T09:02:00Z')).toISOString())
      .toBe('2026-08-31T02:00:00.000Z');
  });
});

describe('monthly gate follows the SERVICED boundary, not the wall clock', () => {
  let lastNightlyBoundary: (nowMs: number) => Date;
  let isFirstOfMonth: (now?: Date) => boolean;
  beforeAll(async () => {
    ({ lastNightlyBoundary } = await import('../src/cron.js'));
    ({ isFirstOfMonth } = await import('../src/batcher.js'));
  });

  // The monthly section accrues and PROPOSES Safe batches and is irreversible
  // (runBatcher aborts an already-proposed cycle rather than recomputing it).
  // Since the scheduler polls, a catch-up run can execute at 01:50 on the 1st while
  // servicing the PREVIOUS day's boundary. Gating on wall-clock isFirstOfMonth()
  // there would propose the new month's cycle before its boundary and before the
  // fetcher ingested the final pre-boundary data.

  it('does NOT treat a 01:50 catch-up on the 1st as first-of-month', () => {
    const now = Date.parse('2026-09-01T01:50:00Z');
    expect(isFirstOfMonth(new Date(now))).toBe(true);              // wall clock says yes
    const boundary = lastNightlyBoundary(now);
    expect(boundary.toISOString()).toBe('2026-08-31T02:00:00.000Z'); // ...but we service Aug 31
    expect(isFirstOfMonth(boundary)).toBe(false);                   // so the gate says NO
  });

  it('DOES treat the run after 02:00 on the 1st as first-of-month', () => {
    const boundary = lastNightlyBoundary(Date.parse('2026-09-01T02:30:00Z'));
    expect(boundary.toISOString()).toBe('2026-09-01T02:00:00.000Z');
    expect(isFirstOfMonth(boundary)).toBe(true);
  });

  it('an ordinary mid-month catch-up is still not first-of-month', () => {
    expect(isFirstOfMonth(lastNightlyBoundary(Date.parse('2026-09-15T01:50:00Z')))).toBe(false);
  });
});
