import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PARTNER_FEE_PARTNER_SHARE_BPS,
  MIN_PARTNER_PAYOUT_USD,
  splitFeeUsdFp,
  usdFpToWei,
  usdToFp,
  fpToUsd,
} from '../../src/partnerFees/split.js';
import { computePartnerFees } from '../../src/partnerFees/computePartnerFees.js';

// Property + unit tests for the pure partner-fee money math (partner-fees Phase B).
// Covers: 80/20 exactness within 1 wei, and the carry invariants.

describe('splitFeeUsdFp (80/20 exactness)', () => {
  it('constants are the spec values', () => {
    expect(PARTNER_FEE_PARTNER_SHARE_BPS).toBe(8000);
    expect(MIN_PARTNER_PAYOUT_USD).toBe(25);
  });

  it('conserves the fee exactly in USD fixed-point (no cent created or lost)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), (feeFp) => {
        const { partnerUsdFp, ophisUsdFp } = splitFeeUsdFp(feeFp);
        // partner + ophis == fee EXACTLY (ophis is the remainder).
        expect(partnerUsdFp + ophisUsdFp).toBe(feeFp);
        // partner is exactly floor(80%); never over-credited.
        expect(partnerUsdFp).toBe((feeFp * 8000n) / 10_000n);
        expect(partnerUsdFp).toBeLessThanOrEqual(feeFp);
      }),
    );
  });

  it('the 80/20 WETH split reconstructs the fee WITHIN 1 WEI (spec property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 22n }),
        fc.double({ min: 100, max: 10_000, noNaN: true }),
        (feeFp, price) => {
          const { partnerUsdFp, ophisUsdFp } = splitFeeUsdFp(feeFp);
          const feeWei = usdFpToWei(feeFp, price);
          const partnerWei = usdFpToWei(partnerUsdFp, price);
          const ophisWei = usdFpToWei(ophisUsdFp, price);
          // Both shares floor, so their sum can only UNDER-shoot the fee, and by at most 1 wei
          // (floor(x)+floor(y) ∈ {floor(x+y), floor(x+y)-1} when x+y is exact). Never over.
          const gap = feeWei - (partnerWei + ophisWei);
          expect(gap === 0n || gap === 1n).toBe(true);
          expect(partnerWei + ophisWei).toBeLessThanOrEqual(feeWei);
        },
      ),
    );
  });

  it('usdFpToWei matches the affiliate/own-fee fixed-point formula exactly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 22n }), fc.double({ min: 1, max: 100_000, noNaN: true }), (usdFp, price) => {
        const priceFp = BigInt(Math.round(price * 10_000));
        fc.pre(priceFp > 0n);
        const expected = usdFp <= 0n ? 0n : (usdFp * 10n ** 18n) / priceFp;
        expect(usdFpToWei(usdFp, price)).toBe(expected);
      }),
    );
  });

  it('usdFpToWei rejects a non-positive price (fail-loud)', () => {
    expect(() => usdFpToWei(10_000n, 0)).toThrow();
    expect(() => usdFpToWei(10_000n, -5)).toThrow();
    expect(() => usdFpToWei(10_000n, NaN)).toThrow();
  });
});

describe('computePartnerFees (carry invariants)', () => {
  const R = (n: number) => (`0x${n.toString(16).padStart(40, '0')}`) as `0x${string}`;

  it('pay XOR carry: paying zeroes the carry, carrying rolls the whole owed forward', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            newFeeUsd: fc.double({ min: 0, max: 100_000, noNaN: true }),
            carriedUsd: fc.double({ min: 0, max: 100, noNaN: true }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        fc.double({ min: 100, max: 10_000, noNaN: true }),
        (rows, price) => {
          const inputs = rows.map((r, i) => ({ recipient: R(i + 1), newFeeUsd: r.newFeeUsd, carriedUsd: r.carriedUsd }));
          const owed = computePartnerFees(inputs, price);
          for (const o of owed) {
            // Exactly one of pay / carry.
            if (o.pay) expect(o.carriedUsd).toBe(0);
            else expect(o.carriedUsd).toBeCloseTo(o.owedUsd, 4);
            // owedWei is the deterministic fixed-point of owedUsd.
            expect(o.owedWei).toBe(usdFpToWei(usdToFp(o.owedUsd), price));
            // pay iff owed cleared the $25 threshold.
            expect(o.pay).toBe(usdToFp(o.owedUsd) >= usdToFp(MIN_PARTNER_PAYOUT_USD));
          }
        },
      ),
    );
  });

  it('owedUsd == 80% of new fee + carry (fixed-point exact)', () => {
    const owed = computePartnerFees([{ recipient: R(1), newFeeUsd: 100, carriedUsd: 3 }], 2_000);
    // 80% of 100 = 80, + 3 carried = 83.
    expect(owed[0]!.owedUsd).toBeCloseTo(83, 4);
    expect(owed[0]!.pay).toBe(true);
    expect(owed[0]!.carriedUsd).toBe(0);
  });

  it('a sub-$25 owed carries; adding it next cycle can cross the threshold and pays IN FULL', () => {
    // Cycle 1: 80% of $20 fee = $16 < $25 -> carry $16.
    const c1 = computePartnerFees([{ recipient: R(1), newFeeUsd: 20, carriedUsd: 0 }], 2_000)[0]!;
    expect(c1.pay).toBe(false);
    expect(c1.carriedUsd).toBeCloseTo(16, 4);
    // Cycle 2: 80% of $20 = $16 + $16 carried = $32 >= $25 -> pays the FULL $32 (carry consumed).
    const c2 = computePartnerFees([{ recipient: R(1), newFeeUsd: 20, carriedUsd: c1.carriedUsd }], 2_000)[0]!;
    expect(c2.pay).toBe(true);
    expect(c2.owedUsd).toBeCloseTo(32, 4);
    expect(c2.carriedUsd).toBe(0);
  });

  it('a pure carry (no new fee) is preserved unchanged until it clears', () => {
    const c = computePartnerFees([{ recipient: R(1), newFeeUsd: 0, carriedUsd: 10 }], 2_000)[0]!;
    expect(c.pay).toBe(false);
    expect(c.owedUsd).toBeCloseTo(10, 4);
    expect(c.carriedUsd).toBeCloseTo(10, 4);
  });

  it('excludes a recipient whose owed rounds to zero, and rejects a duplicate recipient', () => {
    expect(computePartnerFees([{ recipient: R(1), newFeeUsd: 0, carriedUsd: 0 }], 2_000)).toHaveLength(0);
    expect(() =>
      computePartnerFees(
        [
          { recipient: R(1), newFeeUsd: 100 },
          { recipient: R(1), newFeeUsd: 50 },
        ],
        2_000,
      ),
    ).toThrow(/duplicate/i);
  });

  it('fpToUsd/usdToFp round-trip at 4dp', () => {
    expect(fpToUsd(usdToFp(83.1234))).toBeCloseTo(83.1234, 4);
  });
});
