import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeShares, type EligibleWallet } from '../src/batch/computeShares.js';

const wallet = (hex: string): `0x${string}` =>
  (`0x${hex.padStart(40, '0')}`) as `0x${string}`;

describe('computeShares — worked example from the spec', () => {
  it('three wallets, 0.4 WETH safe balance, pool=0.2 WETH', () => {
    const wallets: EligibleWallet[] = [
      { wallet: wallet('a11ce'), volume_30d_usd:  80_000 },  // Gold, 35%
      { wallet: wallet('b0b'),    volume_30d_usd:  10_000 },  // Silver, 20%
      { wallet: wallet('ca501'), volume_30d_usd: 600_000 },  // Platinum, 50%
    ];
    const pool = 200_000_000_000_000_000n;                   // 0.2 WETH
    const shares = computeShares(wallets, pool);

    expect(shares.size).toBe(3);
    // weights: 80k*35% = 28k ; 10k*20% = 2k ; 600k*50% = 300k ; Σ = 330k
    // alice  : 28k/330k * 0.2 WETH ≈ 0.016969… WETH
    // bob    :  2k/330k * 0.2 WETH ≈ 0.001212… WETH
    // carol  : 300k/330k * 0.2 WETH ≈ 0.181818… WETH
    expect(shares.get(wallet('a11ce'))).toBe(16_969_696_969_696_969n);
    expect(shares.get(wallet('b0b'))).toBe(1_212_121_212_121_212n);
    expect(shares.get(wallet('ca501'))).toBe(181_818_181_818_181_818n);
  });
});

describe('computeShares — edge cases', () => {
  it('zero eligible wallets → empty map', () => {
    expect(computeShares([], 10n ** 18n).size).toBe(0);
  });

  it('single eligible wallet gets the entire pool regardless of tier', () => {
    const w = wallet('1');
    for (const vol of [10, 1_000, 80_000, 999_999_999]) {
      const shares = computeShares([{ wallet: w, volume_30d_usd: vol }], 10n ** 18n);
      expect(shares.get(w)).toBe(10n ** 18n);
    }
  });

  it('zero pool → empty map', () => {
    expect(computeShares([{ wallet: wallet('1'), volume_30d_usd: 100 }], 0n).size).toBe(0);
  });

  it('wallet with zero volume contributes zero weight → excluded', () => {
    const a = wallet('a');
    const b = wallet('b');
    const shares = computeShares(
      [{ wallet: a, volume_30d_usd: 0 }, { wallet: b, volume_30d_usd: 100 }],
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
