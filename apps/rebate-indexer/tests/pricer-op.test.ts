import { describe, it, expect } from 'vitest';
import { correctOpNativePrice } from '../src/pricer.js';

// The OP sovereign backend's native_price treats every token as 18 decimals.
// These are the REAL values observed live on 2026-06-10.
describe('correctOpNativePrice — undo OP backend 18-decimal normalization', () => {
  it('corrects a 6-decimal token (USDC) by 10^12 back to the per-atom value', () => {
    // OP returned 6.178e20 for USDC; mainnet (correct, per-atom) is ~6.17e8.
    const opUsdc = 6.178e20;
    const corrected = correctOpNativePrice(opUsdc, 6);
    expect(corrected).toBeCloseTo(6.178e8, -6); // within ~1e6 of 6.178e8
  });

  it('leaves an 18-decimal token (DAI/WETH) unchanged', () => {
    expect(correctOpNativePrice(0.0006175, 18)).toBeCloseTo(0.0006175, 12);
    expect(correctOpNativePrice(1.0, 18)).toBe(1.0); // WETH = native, 1 wei/atom
  });

  it('end-to-end: 1 WETH priced via corrected USDC ref gives a sane ETH/USD', () => {
    // usd = sellAmount * np(WETH)/np(USDC) / 10^refDec, with corrected per-atom np.
    const npWeth = correctOpNativePrice(1.0, 18); // 1.0
    const npUsdc = correctOpNativePrice(6.178e20, 6); // ~6.178e8
    const sellAmount = 1e18; // 1 WETH in atoms
    const usd = (sellAmount * npWeth) / npUsdc / 10 ** 6;
    expect(usd).toBeGreaterThan(1000);
    expect(usd).toBeLessThan(5000); // ~$1619 at the observed rate, sane ETH price
  });

  it('corrects an 8-decimal token (e.g. wBTC) by 10^10', () => {
    expect(correctOpNativePrice(1e10, 8)).toBeCloseTo(1, 6);
  });
});
