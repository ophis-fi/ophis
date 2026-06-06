import { describe, it, expect } from 'vitest';
import { applySlippageFloor } from '../src/batch/convert.js';

describe('applySlippageFloor (#360 fee conversion)', () => {
  it('floors a quoted buyAmount by the given bps', () => {
    expect(applySlippageFloor(10_000n, 200)).toBe(9_800n); // 2%
    expect(applySlippageFloor(1_000_000_000_000_000_000n, 100)).toBe(990_000_000_000_000_000n); // 1% of 1e18
  });

  it('0 bps is identity (no floor)', () => {
    expect(applySlippageFloor(12_345n, 0)).toBe(12_345n);
  });

  it('uses integer (floor) division — never rounds the min-buy up', () => {
    // 101 * 9800 / 10000 = 98.98 -> 98 (a higher min-buy would over-constrain the fill)
    expect(applySlippageFloor(101n, 200)).toBe(98n);
  });

  it('handles 0 buyAmount', () => {
    expect(applySlippageFloor(0n, 200)).toBe(0n);
  });

  it('rejects out-of-range bps (fail-loud, no silent 0% or negative floor)', () => {
    expect(() => applySlippageFloor(1n, -1)).toThrow();
    expect(() => applySlippageFloor(1n, 10_000)).toThrow();
    expect(() => applySlippageFloor(1n, 20_000)).toThrow();
  });
});
