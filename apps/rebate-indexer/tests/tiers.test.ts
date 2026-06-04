import { describe, it, expect } from 'vitest';
import { TIERS, POOL_SPLIT_BPS, assignTier } from '../src/tiers.js';

describe('TIERS table', () => {
  it('has exactly six tiers (none floor + 5 named) in ascending min_usd order', () => {
    expect(TIERS).toHaveLength(6);
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i]!.min_usd).toBeGreaterThan(TIERS[i - 1]!.min_usd);
    }
  });

  it('matches the spec values exactly', () => {
    expect(TIERS).toEqual([
      { name: 'none',      min_usd:         0, rebate_pct: 0.0 },
      { name: 'bronze',    min_usd:    20_000, rebate_pct: 0.10 },
      { name: 'silver',    min_usd:    50_000, rebate_pct: 0.15 },
      { name: 'gold',      min_usd:   100_000, rebate_pct: 0.25 },
      { name: 'palladium', min_usd:   500_000, rebate_pct: 0.35 },
      { name: 'platinum',  min_usd: 1_000_000, rebate_pct: 0.50 },
    ]);
  });

  it('POOL_SPLIT_BPS is 5000 (50%)', () => {
    expect(POOL_SPLIT_BPS).toBe(5_000);
  });
});

describe('assignTier', () => {
  it.each([
    [0,            'none',      0.0],
    [19_999.99,    'none',      0.0],
    [20_000,       'bronze',    0.10],
    [20_000.01,    'bronze',    0.10],
    [49_999.99,    'bronze',    0.10],
    [50_000,       'silver',    0.15],
    [99_999.99,    'silver',    0.15],
    [100_000,      'gold',      0.25],
    [499_999.99,   'gold',      0.25],
    [500_000,      'palladium', 0.35],
    [999_999.99,   'palladium', 0.35],
    [1_000_000,    'platinum',  0.50],
    [10_000_000,   'platinum',  0.50],
  ])('volume %s → %s @ %s', (vol, name, rebate_pct) => {
    expect(assignTier(vol)).toEqual({ name, min_usd: expect.any(Number), rebate_pct });
  });

  it('throws for negative volume (defensive — should never happen)', () => {
    expect(() => assignTier(-1)).toThrow(/non-negative/);
  });
});
