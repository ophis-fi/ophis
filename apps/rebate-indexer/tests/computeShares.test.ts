import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeShares, type EligibleWallet } from '../src/batch/computeShares.js';

const wallet = (hex: string): `0x${string}` =>
  (`0x${hex.padStart(40, '0')}`) as `0x${string}`;

describe('computeShares — worked example from the spec', () => {
  it('three wallets, 0.4 WETH safe balance, pool=0.2 WETH', () => {
    const wallets: EligibleWallet[] = [
      { wallet: wallet('a11ce'), volume_30d_usd:   100_000 }, // Gold, 25%
      { wallet: wallet('b0b'),    volume_30d_usd:    50_000 }, // Silver, 15%
      { wallet: wallet('ca501'), volume_30d_usd: 1_000_000 }, // Platinum, 50%
    ];
    const pool = 200_000_000_000_000_000n;                   // 0.2 WETH
    const shares = computeShares(wallets, pool);

    expect(shares.size).toBe(3);
    // weights: 100k*25% = 25k ; 50k*15% = 7.5k ; 1M*50% = 500k ; Σ = 532.5k
    // alice  :  25k/532.5k * 0.2 WETH ≈ 0.009389… WETH
    // bob    : 7.5k/532.5k * 0.2 WETH ≈ 0.002816… WETH
    // carol  : 500k/532.5k * 0.2 WETH ≈ 0.187793… WETH
    expect(shares.get(wallet('a11ce'))).toBe(9_389_671_361_502_347n);
    expect(shares.get(wallet('b0b'))).toBe(2_816_901_408_450_704n);
    expect(shares.get(wallet('ca501'))).toBe(187_793_427_230_046_948n);
  });
});

describe('computeShares — edge cases', () => {
  it('zero eligible wallets → empty map', () => {
    expect(computeShares([], 10n ** 18n).size).toBe(0);
  });

  it('single eligible wallet gets the entire pool regardless of (earning) tier', () => {
    const w = wallet('1');
    // Above the $20k floor so each maps to an earning tier (bronze..platinum).
    for (const vol of [20_000, 80_000, 500_000, 999_999_999]) {
      const shares = computeShares([{ wallet: w, volume_30d_usd: vol }], 10n ** 18n);
      expect(shares.get(w)).toBe(10n ** 18n);
    }
  });

  it('a lone sub-$20k wallet is unranked (tier none, weight 0) → excluded', () => {
    const w = wallet('2');
    for (const vol of [10, 1_000, 19_999.99]) {
      expect(computeShares([{ wallet: w, volume_30d_usd: vol }], 10n ** 18n).size).toBe(0);
    }
  });

  it('zero pool → empty map', () => {
    expect(computeShares([{ wallet: wallet('1'), volume_30d_usd: 100 }], 0n).size).toBe(0);
  });

  it('wallet with zero volume contributes zero weight → excluded', () => {
    const a = wallet('a');
    const b = wallet('b');
    const shares = computeShares(
      [{ wallet: a, volume_30d_usd: 0 }, { wallet: b, volume_30d_usd: 80_000 }],
      10n ** 18n,
    );
    expect(shares.has(a)).toBe(false);
    expect(shares.get(b)).toBe(10n ** 18n);
  });

  it('throws on duplicate wallet address (caller contract violation)', () => {
    const a = wallet('1');
    expect(() => computeShares(
      [{ wallet: a, volume_30d_usd: 80_000 }, { wallet: a, volume_30d_usd: 90_000 }],
      10n ** 18n,
    )).toThrow(/duplicate wallet/);
  });

  it('skips NaN volume gracefully (does not crash the batch)', () => {
    const a = wallet('a');
    const b = wallet('b');
    const shares = computeShares(
      [{ wallet: a, volume_30d_usd: NaN }, { wallet: b, volume_30d_usd: 80_000 }],
      10n ** 18n,
    );
    expect(shares.has(a)).toBe(false);
    expect(shares.get(b)).toBe(10n ** 18n);
  });

  it('skips Infinity volume gracefully', () => {
    const a = wallet('a');
    const b = wallet('b');
    const shares = computeShares(
      [{ wallet: a, volume_30d_usd: Infinity }, { wallet: b, volume_30d_usd: 80_000 }],
      10n ** 18n,
    );
    expect(shares.has(a)).toBe(false);
    expect(shares.get(b)).toBe(10n ** 18n);
  });
});

describe('computeShares — property: Σ shares ≤ pool, always', () => {
  it('holds across arbitrary wallet sets and pool sizes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            wallet: fc.hexaString({ minLength: 40, maxLength: 40 }).map((h) => (`0x${h}` as `0x${string}`)),
            volume_30d_usd: fc.float({ min: 0, max: 100_000_000, noNaN: true }),
          }),
          { minLength: 0, maxLength: 100 },
        ),
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        (wallets, pool) => {
          const shares = computeShares(wallets, pool);
          const total = [...shares.values()].reduce((a, b) => a + b, 0n);
          expect(total).toBeLessThanOrEqual(pool);
        },
      ),
      { numRuns: 500 },
    );
  });
});
