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
