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
