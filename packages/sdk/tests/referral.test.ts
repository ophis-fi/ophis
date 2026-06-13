import { describe, expect, it } from 'vitest';
import { normalizeOphisReferralCode, buildOphisReferrerMetadata } from '../src/referral.js';

describe('normalizeOphisReferralCode', () => {
  it('lowercases and trims, then accepts a valid code', () => {
    expect(normalizeOphisReferralCode('  ACME-Bot_1  ')).toBe('acme-bot_1');
    expect(normalizeOphisReferralCode('abc')).toBe('abc'); // min length 3
    expect(normalizeOphisReferralCode('a'.repeat(64))).toBe('a'.repeat(64)); // max length 64
  });

  it('rejects codes that cannot exist in the registry (grammar = /^[a-z0-9_-]{3,64}$/)', () => {
    expect(() => normalizeOphisReferralCode('ab')).toThrow(); // too short
    expect(() => normalizeOphisReferralCode('a'.repeat(65))).toThrow(); // too long
    expect(() => normalizeOphisReferralCode('bad code')).toThrow(); // space
    expect(() => normalizeOphisReferralCode('bad.code')).toThrow(); // dot
    expect(() => normalizeOphisReferralCode('bad/code')).toThrow(); // slash
    expect(() => normalizeOphisReferralCode('')).toThrow();
  });

  it('matches the indexer ref-code grammar exactly (lowercase letters, digits, _ and -)', () => {
    // Mirror of apps/rebate-indexer api.ts /^[a-z0-9_-]{3,64}$/. If this diverges,
    // a code embedded in appData would not join a ref_codes row at accrual time.
    const re = /^[a-z0-9_-]{3,64}$/;
    for (const c of ['abc', 'a_b-c', 'partner123', 'x'.repeat(64)]) {
      expect(re.test(normalizeOphisReferralCode(c))).toBe(true);
    }
  });
});

describe('buildOphisReferrerMetadata', () => {
  it('produces the appData metadata fragment the indexer reads', () => {
    expect(buildOphisReferrerMetadata('Acme')).toEqual({ ophisReferrer: { code: 'acme' } });
  });

  it('merges cleanly into an existing metadata object', () => {
    const metadata = { orderClass: { orderClass: 'market' }, ...buildOphisReferrerMetadata('acme') };
    expect((metadata as any).ophisReferrer.code).toBe('acme');
    expect((metadata as any).orderClass.orderClass).toBe('market');
  });

  it('throws (does not silently drop) on an invalid code', () => {
    expect(() => buildOphisReferrerMetadata('no')).toThrow();
  });
});
