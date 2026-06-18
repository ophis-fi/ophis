import { describe, it, expect } from 'vitest';
import {
  keepFractionBps,
  effectiveVolumeBps,
  SELF_HOSTED_CHAIN_IDS,
  OPTIMISM_CHAIN_ID,
  HYPEREVM_CHAIN_ID,
} from '../../src/affiliate/rates.js';

// HyperEVM (999) re-enable: it is a SELF-HOSTED Ophis backend, so Ophis keeps the
// full fee (no CoW 25% cut) exactly like Optimism (10). These pin the self-hosted
// rate so a future hosted-vs-self-hosted regression is caught.
describe('rates — HyperEVM (999) is self-hosted, keeps the full fee', () => {
  it('keepFractionBps(999) === 10_000 (100%), same as OP', () => {
    expect(keepFractionBps(HYPEREVM_CHAIN_ID)).toBe(10_000);
    expect(keepFractionBps(999)).toBe(10_000);
    expect(keepFractionBps(OPTIMISM_CHAIN_ID)).toBe(10_000);
  });

  it('keepFractionBps for a hosted chain stays 7_500 (75%, after CoW 25% cut)', () => {
    expect(keepFractionBps(1)).toBe(7_500);
    expect(keepFractionBps(100)).toBe(7_500);
  });

  it('SELF_HOSTED_CHAIN_IDS contains 10 and 999', () => {
    expect(SELF_HOSTED_CHAIN_IDS.has(OPTIMISM_CHAIN_ID)).toBe(true);
    expect(SELF_HOSTED_CHAIN_IDS.has(HYPEREVM_CHAIN_ID)).toBe(true);
    expect(SELF_HOSTED_CHAIN_IDS.has(1)).toBe(false);
  });

  it('effectiveVolumeBps on 999 matches the OP self-hosted rate (0.80 regular / 1.20 partner)', () => {
    // = (FEE_SHARE_BPS/1e4) * GROSS_FEE_BPS * (keepFractionBps/1e4)
    //   regular: 0.08 * 10 * 1.00 = 0.80 ; partner: 0.12 * 10 * 1.00 = 1.20
    expect(effectiveVolumeBps('regular', HYPEREVM_CHAIN_ID)).toBeCloseTo(0.8, 10);
    expect(effectiveVolumeBps('partner', HYPEREVM_CHAIN_ID)).toBeCloseTo(1.2, 10);
    // identical to OP
    expect(effectiveVolumeBps('regular', HYPEREVM_CHAIN_ID)).toBe(effectiveVolumeBps('regular', OPTIMISM_CHAIN_ID));
    expect(effectiveVolumeBps('partner', HYPEREVM_CHAIN_ID)).toBe(effectiveVolumeBps('partner', OPTIMISM_CHAIN_ID));
  });

  it('hosted-chain rate stays lower than the self-hosted rate (0.60 regular / 0.90 partner)', () => {
    expect(effectiveVolumeBps('regular', 100)).toBeCloseTo(0.6, 10);
    expect(effectiveVolumeBps('partner', 100)).toBeCloseTo(0.9, 10);
  });
});
