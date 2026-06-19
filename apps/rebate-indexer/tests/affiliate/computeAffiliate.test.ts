import { describe, it, expect } from 'vitest';
import {
  computeAffiliate,
  type AffiliateReferrer,
  type AffiliateVolumeBucket,
} from '../../src/affiliate/computeAffiliate.js';
import {
  OPTIMISM_CHAIN_ID,
  estimateEarningsUsd,
  GROSS_FEE_BPS,
  type AffiliateKind,
} from '../../src/affiliate/rates.js';

const wallet = (hex: string): `0x${string}` => (`0x${hex.padStart(40, '0')}`) as `0x${string}`;
const HOSTED = 100; // Gnosis (any hosted chain — CoW takes 25%)
const PRICE = 2_500; // USD per WETH

// owedWei the function should produce for a given USD owed at PRICE.
const wei = (owedUsd: number): bigint => (BigInt(Math.round(owedUsd * 10_000)) * 10n ** 18n) / BigInt(PRICE * 10_000);

const ref = (w: `0x${string}`, kind: AffiliateKind, buckets: AffiliateVolumeBucket[]): AffiliateReferrer => ({
  referrer_wallet: w,
  kind,
  buckets,
});

// All-RETAIL (10 bps) buckets from a chain->volume map, so the model-table
// expectations (defined at the 10 bps rate) hold unchanged after the per-trade fix.
const retailRef = (w: `0x${string}`, kind: AffiliateKind, v: Map<number, number>): AffiliateReferrer =>
  ref(w, kind, [...v].map(([chainId, volumeUsd]) => ({ chainId, volumeUsd, grossBps: GROSS_FEE_BPS })));

describe('computeAffiliate — matches the model doc earnings tables (all-retail 10 bps)', () => {
  it('Regular hosted under cap: $500k -> 0.6 bps -> $30', () => {
    const r = computeAffiliate([retailRef(wallet('a'), 'regular', new Map([[HOSTED, 500_000]]))], PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(30, 6);
    expect(r.referredVolumeUsd).toBe(500_000);
    expect(r.owedWei).toBe(wei(30));
  });

  it('Regular hosted at $1M -> $60 (model: Regular hosted $60/$1M)', () => {
    const r = computeAffiliate([retailRef(wallet('a'), 'regular', new Map([[HOSTED, 1_000_000]]))], PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(60, 6);
  });

  it('Regular HARD-STOP: $5M hosted flat-lines at the $1M cap -> $60, not $300', () => {
    const r = computeAffiliate([retailRef(wallet('a'), 'regular', new Map([[HOSTED, 5_000_000]]))], PRICE)[0]!;
    expect(r.referredVolumeUsd).toBe(1_000_000); // capped
    expect(r.owedUsd).toBeCloseTo(60, 6);
  });

  it('Partner hosted uncapped: $5M -> 0.9 bps -> $450 (model: VIP hosted $450/$5M)', () => {
    const r = computeAffiliate([retailRef(wallet('b'), 'partner', new Map([[HOSTED, 5_000_000]]))], PRICE)[0]!;
    expect(r.referredVolumeUsd).toBe(5_000_000);
    expect(r.owedUsd).toBeCloseTo(450, 6);
  });

  it('OP-ready: Regular $1M on Optimism -> 0.8 bps -> $80 (model: Regular OP $80/$1M)', () => {
    const r = computeAffiliate([retailRef(wallet('a'), 'regular', new Map([[OPTIMISM_CHAIN_ID, 1_000_000]]))], PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(80, 6);
  });

  it('Partner $10M on OP -> 1.2 bps -> $1,200 (model: VIP OP $1,200/$10M)', () => {
    const r = computeAffiliate([retailRef(wallet('b'), 'partner', new Map([[OPTIMISM_CHAIN_ID, 10_000_000]]))], PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(1_200, 6);
  });

  it('multi-chain cap is OP-FIRST: $800k OP + $500k hosted, cap $1M -> keep all OP + $200k hosted', () => {
    // OP $800k @0.8bps = $64 ; remaining cap $200k hosted @0.6bps = $12 ; total $76.
    const r = computeAffiliate(
      [retailRef(wallet('a'), 'regular', new Map([[OPTIMISM_CHAIN_ID, 800_000], [HOSTED, 500_000]]))],
      PRICE,
    )[0]!;
    expect(r.referredVolumeUsd).toBe(1_000_000);
    expect(r.owedUsd).toBeCloseTo(76, 6);
  });

  it('owedWei == owedUsd / price * 1e18 (within 1 wei)', () => {
    const r = computeAffiliate([retailRef(wallet('b'), 'partner', new Map([[HOSTED, 3_333_333]]))], PRICE)[0]!;
    const expected = (BigInt(Math.round(r.owedUsd * 1e4)) * 10n ** 18n) / BigInt(PRICE * 1e4);
    const diff = r.owedWei > expected ? r.owedWei - expected : expected - r.owedWei;
    expect(diff).toBeLessThanOrEqual(1n);
  });

  it('excludes zero-volume and zero-owed; empty input -> []', () => {
    expect(computeAffiliate([], PRICE)).toEqual([]);
    const refs = [
      retailRef(wallet('a'), 'regular', new Map([[HOSTED, 0]])),
      ref(wallet('b'), 'regular', []),
    ];
    expect(computeAffiliate(refs, PRICE)).toEqual([]);
  });

  it('throws on duplicate referrer and non-positive price', () => {
    const dup = [
      retailRef(wallet('a'), 'regular', new Map([[HOSTED, 100_000]])),
      retailRef(wallet('a'), 'partner', new Map([[HOSTED, 100_000]])),
    ];
    expect(() => computeAffiliate(dup, PRICE)).toThrow(/duplicate referrer/);
    const ok = [retailRef(wallet('a'), 'regular', new Map([[HOSTED, 100_000]]))];
    expect(() => computeAffiliate(ok, 0)).toThrow(/positive/);
  });
});

describe('computeAffiliate — per-channel fee base (the 5/10/1 bps fix)', () => {
  it('SDK 5 bps earns HALF of retail 10 bps: regular hosted $1M -> $30 (not $60)', () => {
    const r = computeAffiliate([ref(wallet('a'), 'regular', [{ chainId: HOSTED, volumeUsd: 1_000_000, grossBps: 5 }])], PRICE)[0]!;
    // gross = $1M * 5bps = $500 ; owed = 8% * 75% * $500 = $30.
    expect(r.owedUsd).toBeCloseTo(30, 6);
    expect(r.referredVolumeUsd).toBe(1_000_000); // full referred volume still shown
  });

  it('partner SDK 5 bps hosted $5M -> $225 (half of the $450 retail figure)', () => {
    const r = computeAffiliate([ref(wallet('b'), 'partner', [{ chainId: HOSTED, volumeUsd: 5_000_000, grossBps: 5 }])], PRICE)[0]!;
    expect(r.owedUsd).toBeCloseTo(225, 6);
  });

  it('stable 1 bp earns a TENTH: regular hosted $1M -> $6', () => {
    const r = computeAffiliate([ref(wallet('a'), 'regular', [{ chainId: HOSTED, volumeUsd: 1_000_000, grossBps: 1 }])], PRICE)[0]!;
    // gross = $1M * 1bp = $100 ; owed = 8% * 75% * $100 = $6.
    expect(r.owedUsd).toBeCloseTo(6, 6);
  });

  it('mixed channel on one chain: tier share of the SUM of the two buckets actual fees', () => {
    // $600k retail (10bps) + $400k SDK (5bps) on the same chain, under cap.
    const r = computeAffiliate(
      [ref(wallet('a'), 'regular', [
        { chainId: HOSTED, volumeUsd: 600_000, grossBps: 10 },
        { chainId: HOSTED, volumeUsd: 400_000, grossBps: 5 },
      ])],
      PRICE,
    )[0]!;
    // gross = $600 + $200 = $800 ; owed = 8% * 75% * $800 = $48 (between $60 all-retail and $30 all-SDK).
    expect(r.owedUsd).toBeCloseTo(48, 6);
  });

  it('WITHIN-CHAIN cap discards LEAST-VALUABLE first: $700k@10bps + $700k@1bp on one chain, cap $1M', () => {
    // Sort by rate: 10-bps bucket first. Take all $700k@10bps ($42), then $300k of
    // the $700k@1bp bucket ($4.20 * 300/700 = $1.80). Total $43.80 — NOT the blended
    // per-chain figure ($33) the old per-chain-aggregate cap would give.
    const r = computeAffiliate(
      [ref(wallet('a'), 'regular', [
        { chainId: HOSTED, volumeUsd: 700_000, grossBps: 10 },
        { chainId: HOSTED, volumeUsd: 700_000, grossBps: 1 },
      ])],
      PRICE,
    )[0]!;
    expect(r.referredVolumeUsd).toBe(1_000_000);
    expect(r.owedUsd).toBeCloseTo(43.8, 6);
  });

  it('cross-chain cap discards least-valuable last: $700k hosted@10bps + $700k hosted@5bps, cap $1M', () => {
    // chain 100 @10bps ($42 full) outranks chain 137 @5bps; take 100 fully, then $300k of 137.
    const r = computeAffiliate(
      [ref(wallet('a'), 'regular', [
        { chainId: 100, volumeUsd: 700_000, grossBps: 10 },
        { chainId: 137, volumeUsd: 700_000, grossBps: 5 },
      ])],
      PRICE,
    )[0]!;
    // 100: 8%*75%*$700 = $42 ; 137 partial: ($21 full) * 300/700 = $9 ; total $51.
    expect(r.referredVolumeUsd).toBe(1_000_000);
    expect(r.owedUsd).toBeCloseTo(51, 6);
  });
});

describe('estimateEarningsUsd — dashboard current-cycle UPPER BOUND (assumes retail, hosted-only)', () => {
  it('partner is uncapped: $5M -> 0.9 bps -> $450 (upper bound at retail)', () => {
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
