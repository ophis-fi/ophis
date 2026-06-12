import { describe, it, expect } from 'vitest';
import { assignTier, TIERS } from '../src/tiers.js';
import {
  getNextTierInfo,
  computeTierProgress,
  truncateWallet,
  markSelf,
  type LeaderboardEntry,
} from '../src/leaderboard.js';

describe('getNextTierInfo', () => {
  it('returns null for platinum tier (the top)', () => {
    const platinumTier = TIERS[5]!; // platinum
    const { nextTier, nextThresholdUsd } = getNextTierInfo(platinumTier);
    expect(nextTier).toBeNull();
    expect(nextThresholdUsd).toBeNull();
  });

  it('returns silver tier for bronze', () => {
    const bronzeTier = TIERS[1]!; // bronze
    const { nextTier, nextThresholdUsd } = getNextTierInfo(bronzeTier);
    expect(nextTier?.name).toBe('silver');
    expect(nextThresholdUsd).toBe(50_000);
  });

  it('returns gold tier for silver', () => {
    const silverTier = TIERS[2]!; // silver
    const { nextTier, nextThresholdUsd } = getNextTierInfo(silverTier);
    expect(nextTier?.name).toBe('gold');
    expect(nextThresholdUsd).toBe(100_000);
  });

  it('returns palladium tier for gold', () => {
    const goldTier = TIERS[3]!; // gold
    const { nextTier, nextThresholdUsd } = getNextTierInfo(goldTier);
    expect(nextTier?.name).toBe('palladium');
    expect(nextThresholdUsd).toBe(500_000);
  });

  it('returns platinum tier for palladium', () => {
    const palladiumTier = TIERS[4]!; // palladium
    const { nextTier, nextThresholdUsd } = getNextTierInfo(palladiumTier);
    expect(nextTier?.name).toBe('platinum');
    expect(nextThresholdUsd).toBe(1_000_000);
  });
});

describe('computeTierProgress', () => {
  it('computes distance to next tier correctly', () => {
    const bronzeTier = assignTier(20_000);
    const progress = computeTierProgress(20_000, bronzeTier);
    expect(progress.nextTier).toBe('silver');
    expect(progress.nextThresholdUsd).toBe(50_000);
    expect(progress.toNextUsd).toBe(30_000);
  });

  it('computes zero distance when already at threshold', () => {
    const silverTier = assignTier(50_000);
    const progress = computeTierProgress(50_000, silverTier);
    expect(progress.nextTier).toBe('gold');
    expect(progress.toNextUsd).toBe(50_000);
  });

  it('handles platinum tier (no next tier)', () => {
    const platinumTier = assignTier(1_000_000);
    const progress = computeTierProgress(1_000_000, platinumTier);
    expect(progress.nextTier).toBeNull();
    expect(progress.nextThresholdUsd).toBeNull();
    expect(progress.toNextUsd).toBeNull();
  });

  it('computes for high volumes correctly', () => {
    const platinumTier = assignTier(2_000_000);
    const progress = computeTierProgress(2_000_000, platinumTier);
    expect(progress.nextTier).toBeNull();
    expect(progress.toNextUsd).toBeNull();
  });

  it('handles none tier (floor)', () => {
    const noneTier = assignTier(0);
    const progress = computeTierProgress(0, noneTier);
    expect(progress.nextTier).toBe('bronze');
    expect(progress.nextThresholdUsd).toBe(20_000);
    expect(progress.toNextUsd).toBe(20_000);
  });

  it('handles progress near the next tier boundary', () => {
    const goldTier = assignTier(100_000); // At gold tier
    const progress = computeTierProgress(100_000, goldTier);
    expect(progress.nextTier).toBe('palladium');
    // Distance should be 500_000 - 100_000 = 400_000
    expect(progress.toNextUsd).toBe(400_000);
  });
});

describe('LeaderboardEntry structure', () => {
  it('has required fields', () => {
    const entry: LeaderboardEntry = {
      rank: 1,
      wallet: '0xaaaa...aaaa', // truncated display form, not the full address
      tier: 'bronze',
      volume30dUsd: 25_000,
      volumeTotalUsd: 100_000,
      affiliateCount: 5,
      referredVolumeUsd: 50_000,
    };
    expect(entry.rank).toBe(1);
    expect(entry.wallet).toBe('0xaaaa...aaaa');
    expect(entry.tier).toBe('bronze');
    expect(entry.volume30dUsd).toBe(25_000);
    expect(entry.volumeTotalUsd).toBe(100_000);
    expect(entry.affiliateCount).toBe(5);
    expect(entry.referredVolumeUsd).toBe(50_000);
  });
});

describe('truncateWallet (leaderboard address privacy)', () => {
  it('returns the 0xXXXX...XXXX display form', () => {
    expect(truncateWallet('0x0494f503912c101bfd76b88e4f5d8a33de284d1a')).toBe('0x0494...4d1a');
  });

  it('never exposes the full address (the leaderboard deanon fix)', () => {
    const full = '0x' + 'a'.repeat(40);
    const t = truncateWallet(full);
    expect(t).toBe('0xaaaa...aaaa');
    expect(t).not.toBe(full);
    expect(t.length).toBeLessThan(full.length);
  });
});

describe('markSelf (collision-free self-identification)', () => {
  const base = { tier: 'gold', volume30dUsd: 100, volumeTotalUsd: 100, affiliateCount: 0, referredVolumeUsd: 0 };
  // Two DISTINCT full addresses that collide on the truncated display form
  // (same first-4 + last-2 bytes, different middle).
  const fullA = 'aaaa' + 'c'.repeat(32) + 'bbbb';
  const fullB = 'aaaa' + 'd'.repeat(32) + 'bbbb';
  const entryA = { rank: 1, wallet: truncateWallet(`0x${fullA}`), walletHexFull: fullA, ...base };
  const entryB = { rank: 2, wallet: truncateWallet(`0x${fullB}`), walletHexFull: fullB, ...base };

  it('marks ONLY the true full-address match, even when truncated forms collide', () => {
    // Precondition: the two distinct addresses share a truncated display form.
    expect(entryA.wallet).toBe(entryB.wallet);
    const out = markSelf([entryA, entryB], `0x${fullA}`);
    expect(out[0]!.isSelf).toBe(true);
    // The collision row is NOT mislabelled "you" (the bug a string match had).
    expect(out[1]!.isSelf).toBe(false);
  });

  it('never serializes the server-only walletHexFull', () => {
    const out = markSelf([entryA], `0x${fullA}`);
    expect('walletHexFull' in out[0]!).toBe(false);
    expect(out[0]!.wallet).toBe('0xaaaa...bbbb');
  });

  it('returns the public entries unchanged (no isSelf) when self is null', () => {
    const out = markSelf([entryA, entryB], null);
    expect(out[0]!.isSelf).toBeUndefined();
    expect(out[1]!.isSelf).toBeUndefined();
    expect('walletHexFull' in out[0]!).toBe(false);
  });

  it('matches case-insensitively for a checksummed/upper-cased self address', () => {
    const out = markSelf([entryA], `0x${fullA}`.toUpperCase());
    expect(out[0]!.isSelf).toBe(true);
  });

  it('marks nobody when the connected wallet is absent from the snapshot', () => {
    const out = markSelf([entryA, entryB], `0x${'e'.repeat(40)}`);
    expect(out.some((e) => e.isSelf)).toBe(false);
  });
});

describe('tier naming for leaderboard', () => {
  it('assigns correct tier names for various volumes', () => {
    const testCases: Array<[number, string]> = [
      [0, 'none'],
      [10_000, 'none'],
      [20_000, 'bronze'],
      [50_000, 'silver'],
      [100_000, 'gold'],
      [500_000, 'palladium'],
      [1_000_000, 'platinum'],
    ];
    
    for (const [volume, expectedTier] of testCases) {
      const tier = assignTier(volume);
      expect(tier.name).toBe(expectedTier);
    }
  });
});
