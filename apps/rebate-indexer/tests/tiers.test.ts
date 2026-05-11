import { describe, it, expect } from 'vitest';
import { TIERS, POOL_SPLIT_BPS, assignTier } from '../src/tiers.js';

describe('TIERS table', () => {
  it('has exactly four tiers in ascending min_usd order', () => {
    expect(TIERS).toHaveLength(4);
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i]!.min_usd).toBeGreaterThan(TIERS[i - 1]!.min_usd);
    }
  });

  it('matches the spec values exactly', () => {
    expect(TIERS).toEqual([
      { name: 'bronze',   min_usd:      0, rebate_pct: 0.10 },
      { name: 'silver',   min_usd:  5_000, rebate_pct: 0.20 },
      { name: 'gold',     min_usd: 50_000, rebate_pct: 0.35 },
      { name: 'platinum', min_usd: 500_000, rebate_pct: 0.50 },
    ]);
  });

  it('POOL_SPLIT_BPS is 5000 (50%)', () => {
    expect(POOL_SPLIT_BPS).toBe(5_000);
  });
});

describe('assignTier', () => {
  it.each([
    [0,           'bronze',   0.10],
    [4_999.99,    'bronze',   0.10],
    [5_000,       'silver',   0.20],
    [5_000.01,    'silver',   0.20],
    [49_999.99,   'silver',   0.20],
    [50_000,      'gold',     0.35],
    [499_999.99,  'gold',     0.35],
    [500_000,     'platinum', 0.50],
    [10_000_000,  'platinum', 0.50],
  ])('volume %s → %s @ %s', (vol, name, rebate_pct) => {
    expect(assignTier(vol)).toEqual({ name, min_usd: expect.any(Number), rebate_pct });
  });

  it('throws for negative volume (defensive — should never happen)', () => {
    expect(() => assignTier(-1)).toThrow(/non-negative/);
  });
});
