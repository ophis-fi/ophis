import { describe, it, expect } from 'vitest';
import { computeAffiliate, type AffiliateReferrer } from '../../src/affiliate/computeAffiliate.js';
import { OPTIMISM_CHAIN_ID, estimateEarningsUsd } from '../../src/affiliate/rates.js';

const wallet = (hex: string): `0x${string}` => (`0x${hex.padStart(40, '0')}`) as `0x${string}`;
const HOSTED = 100; // Gnosis (any hosted chain — CoW takes 25%)
const PRICE = 2_500; // USD per WETH

// owedWei the function should produce for a given USD owed at PRICE.
const wei = (owedUsd: number): bigint => (BigInt(Math.round(owedUsd * 10_000)) * 10n ** 18n) / BigInt(PRICE * 10_000);

describe('computeAffiliate — matches the model doc earnings tables', () => {
  it('Regular hosted under cap: $500k -> 0.6 bps -> $30', () => {
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('a'), kind: 'regular', volumeByChain: new Map([[HOSTED, 500_000]]) },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(30, 6);
    expect(r.referredVolumeUsd).toBe(500_000);
    expect(r.owedWei).toBe(wei(30));
  });

  it('Regular hosted at $1M -> $60 (model: Regular hosted $60/$1M)', () => {
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('a'), kind: 'regular', volumeByChain: new Map([[HOSTED, 1_000_000]]) },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(60, 6);
  });

  it('Regular HARD-STOP: $5M hosted flat-lines at the $1M cap -> $60, not $300', () => {
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('a'), kind: 'regular', volumeByChain: new Map([[HOSTED, 5_000_000]]) },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    expect(r.referredVolumeUsd).toBe(1_000_000); // capped
    expect(r.owedUsd).toBeCloseTo(60, 6);
  });

  it('Partner hosted uncapped: $5M -> 0.9 bps -> $450 (model: VIP hosted $450/$5M)', () => {
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('b'), kind: 'partner', volumeByChain: new Map([[HOSTED, 5_000_000]]) },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    expect(r.referredVolumeUsd).toBe(5_000_000);
    expect(r.owedUsd).toBeCloseTo(450, 6);
  });

  it('OP-ready: Regular $1M on Optimism -> 0.8 bps -> $80 (model: Regular OP $80/$1M)', () => {
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('a'), kind: 'regular', volumeByChain: new Map([[OPTIMISM_CHAIN_ID, 1_000_000]]) },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(80, 6);
  });

  it('Partner $10M on OP -> 1.2 bps -> $1,200 (model: VIP OP $1,200/$10M)', () => {
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('b'), kind: 'partner', volumeByChain: new Map([[OPTIMISM_CHAIN_ID, 10_000_000]]) },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(1_200, 6);
  });

  it('multi-chain cap is OP-FIRST: $800k OP + $500k hosted, cap $1M -> keep all OP + $200k hosted', () => {
    // OP $800k @0.8bps = $64 ; remaining cap $200k hosted @0.6bps = $12 ; total $76.
    const refs: AffiliateReferrer[] = [
      {
        referrer_wallet: wallet('a'),
        kind: 'regular',
        volumeByChain: new Map([[OPTIMISM_CHAIN_ID, 800_000], [HOSTED, 500_000]]),
      },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    expect(r.referredVolumeUsd).toBe(1_000_000);
    expect(r.owedUsd).toBeCloseTo(76, 6);
  });

  it('owedWei == owedUsd / price * 1e18 (within 1 wei)', () => {
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('b'), kind: 'partner', volumeByChain: new Map([[HOSTED, 3_333_333]]) },
    ];
    const r = computeAffiliate(refs, PRICE)[0]!;
    const expected = (BigInt(Math.round(r.owedUsd * 1e4)) * 10n ** 18n) / BigInt(PRICE * 1e4);
    const diff = r.owedWei > expected ? r.owedWei - expected : expected - r.owedWei;
    expect(diff).toBeLessThanOrEqual(1n);
  });

  it('excludes zero-volume and zero-owed; empty input -> []', () => {
    expect(computeAffiliate([], PRICE)).toEqual([]);
    const refs: AffiliateReferrer[] = [
      { referrer_wallet: wallet('a'), kind: 'regular', volumeByChain: new Map([[HOSTED, 0]]) },
      { referrer_wallet: wallet('b'), kind: 'regular', volumeByChain: new Map() },
    ];
    expect(computeAffiliate(refs, PRICE)).toEqual([]);
  });

  it('throws on duplicate referrer and non-positive price', () => {
    const dup: AffiliateReferrer[] = [
      { referrer_wallet: wallet('a'), kind: 'regular', volumeByChain: new Map([[HOSTED, 100_000]]) },
      { referrer_wallet: wallet('a'), kind: 'partner', volumeByChain: new Map([[HOSTED, 100_000]]) },
    ];
    expect(() => computeAffiliate(dup, PRICE)).toThrow(/duplicate referrer/);
    const ok: AffiliateReferrer[] = [
      { referrer_wallet: wallet('a'), kind: 'regular', volumeByChain: new Map([[HOSTED, 100_000]]) },
    ];
    expect(() => computeAffiliate(ok, 0)).toThrow(/positive/);
  });
});

describe('estimateEarningsUsd — dashboard current-cycle estimate (hosted-only)', () => {
  it('partner is uncapped: $5M -> 0.9 bps -> $450 (matches the monthly accrual)', () => {
    expect(estimateEarningsUsd(5_000_000, 'partner')).toBeCloseTo(450, 6);
  });

  it('regular under cap: $500k -> 0.6 bps -> $30', () => {
    expect(estimateEarningsUsd(500_000, 'regular')).toBeCloseTo(30, 6);
  });

  it('regular caps at $1M/month: $5M -> $60, not $300', () => {
    expect(estimateEarningsUsd(5_000_000, 'regular')).toBeCloseTo(60, 6);
  });

  it('partner $1M -> $90', () => {
    expect(estimateEarningsUsd(1_000_000, 'partner')).toBeCloseTo(90, 6);
  });

  it('zero, negative, or non-finite volume -> 0', () => {
    expect(estimateEarningsUsd(0, 'partner')).toBe(0);
    expect(estimateEarningsUsd(-100, 'partner')).toBe(0);
    expect(estimateEarningsUsd(Number.NaN, 'partner')).toBe(0);
  });
});
