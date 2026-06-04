import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeDirectRebates } from '../src/batch/computeDirectRebates.js';
import type { EligibleWallet } from '../src/batch/computeShares.js';

const wallet = (hex: string): `0x${string}` => (`0x${hex.padStart(40, '0')}`) as `0x${string}`;
const ONE_WETH = 10n ** 18n;

describe('computeDirectRebates — worked example', () => {
  it('each wallet gets its tier% of its volume-share of F; none-tier dilutes but earns 0', () => {
    // F = 1 WETH. Total volume (incl. the sub-floor D) = $110k.
    const wallets: EligibleWallet[] = [
      { wallet: wallet('a'), volume_30d_usd: 50_000 }, // silver 15%
      { wallet: wallet('b'), volume_30d_usd: 30_000 }, // bronze 10%
      { wallet: wallet('c'), volume_30d_usd: 20_000 }, // bronze 10%
      { wallet: wallet('d'), volume_30d_usd: 10_000 }, // none 0% -> excluded, but counts in the denominator
    ];
    const r = computeDirectRebates(wallets, ONE_WETH);
    // share_i = F*vol_i/110k ; rebate_i = tier%_i * share_i (floor at each step)
    expect(r.get(wallet('a'))).toBe(68_181_818_181_818_181n); // 15% of 50/110 WETH
    expect(r.get(wallet('b'))).toBe(27_272_727_272_727_272n); // 10% of 30/110 WETH
    expect(r.get(wallet('c'))).toBe(18_181_818_181_818_181n); // 10% of 20/110 WETH
    expect(r.has(wallet('d'))).toBe(false); // none tier, excluded
    expect(r.size).toBe(3);
    const paid = [...r.values()].reduce((s, x) => s + x, 0n);
    expect(paid).toBe(113_636_363_636_363_634n);
    expect(paid).toBeLessThan(ONE_WETH); // Ophis keeps the rest (~88.6%)
  });
});

describe('computeDirectRebates — edge cases', () => {
  it('single wallet gets tier% of F (never the whole pool)', () => {
    // $100k -> gold 25%. Sole wallet => full fee-share = F, rebate = 25% of F.
    const r = computeDirectRebates([{ wallet: wallet('1'), volume_30d_usd: 100_000 }], ONE_WETH);
    expect(r.get(wallet('1'))).toBe(250_000_000_000_000_000n); // 0.25 WETH
    expect([...r.values()].reduce((s, x) => s + x, 0n)).toBeLessThan(ONE_WETH);
  });

  it('all wallets below the $20k floor -> empty map (batcher records no_recipients)', () => {
    const r = computeDirectRebates(
      [{ wallet: wallet('a'), volume_30d_usd: 10_000 }, { wallet: wallet('b'), volume_30d_usd: 5_000 }],
      ONE_WETH,
    );
    expect(r.size).toBe(0);
  });

  it('zero Safe balance -> empty map (no division by zero)', () => {
    expect(computeDirectRebates([{ wallet: wallet('1'), volume_30d_usd: 100_000 }], 0n).size).toBe(0);
  });

  it('no wallets -> empty map', () => {
    expect(computeDirectRebates([], ONE_WETH).size).toBe(0);
  });

  it('tier boundary: $20,000 earns Bronze, $19,999.99 is unranked (excluded)', () => {
    const r = computeDirectRebates(
      [{ wallet: wallet('a'), volume_30d_usd: 20_000 }, { wallet: wallet('b'), volume_30d_usd: 19_999.99 }],
      ONE_WETH,
    );
    expect(r.get(wallet('a'))).toBe(50_000_012_500_003_125n); // 10% of a's share of F (b dilutes the denominator)
    expect(r.has(wallet('b'))).toBe(false);
    expect(r.size).toBe(1);
  });

  it('throws on duplicate wallet address (caller contract violation)', () => {
    const a = wallet('1');
    expect(() => computeDirectRebates(
      [{ wallet: a, volume_30d_usd: 80_000 }, { wallet: a, volume_30d_usd: 90_000 }],
      ONE_WETH,
    )).toThrow(/duplicate wallet/);
  });

  it('skips NaN / Infinity volume gracefully', () => {
    const r = computeDirectRebates(
      [
        { wallet: wallet('a'), volume_30d_usd: NaN },
        { wallet: wallet('b'), volume_30d_usd: Infinity },
        { wallet: wallet('c'), volume_30d_usd: 80_000 }, // silver
      ],
      ONE_WETH,
    );
    expect(r.has(wallet('a'))).toBe(false);
    expect(r.has(wallet('b'))).toBe(false);
    expect(r.has(wallet('c'))).toBe(true);
    expect(r.size).toBe(1);
  });
});

describe('computeDirectRebates — property: Σrebates < F always', () => {
  it('holds across arbitrary wallet sets and balances (every tier <= 50%)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ idx: fc.integer({ min: 1, max: 1_000_000 }), vol: fc.double({ min: 0, max: 5_000_000, noNaN: true }) }), { maxLength: 30 }),
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        (raw, F) => {
          // de-dupe by idx so we never violate the caller contract
          const seen = new Set<number>();
          const wallets: EligibleWallet[] = [];
          for (const { idx, vol } of raw) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            wallets.push({ wallet: wallet(idx.toString(16)), volume_30d_usd: vol });
          }
          const r = computeDirectRebates(wallets, F);
          const sum = [...r.values()].reduce((s, x) => s + x, 0n);
          expect(sum).toBeLessThanOrEqual(F); // never over-pays the Safe
          if (F > 0n) expect(sum).toBeLessThan(F); // Ophis always keeps a positive remainder
        },
      ),
      { numRuns: 300 },
    );
  });
});
