import { describe, expect, it } from 'vitest';
import { allocationCommitment, buildRewardAllocation, parseAllocationSeed } from '../../src/tradeRewards/allocation.js';

describe('trade reward allocation', () => {
  const seed = Buffer.alloc(32, 7);

  it('is deterministic and contains exactly the funded inventory', () => {
    const first = buildRewardAllocation(seed);
    const second = buildRewardAllocation(seed);

    expect(first).toEqual(second);
    expect(first).toHaveLength(105);
    expect(first.filter((amount) => amount === 1_000_000n)).toHaveLength(100);
    expect(first.filter((amount) => amount === 10_000_000n)).toHaveLength(5);
    expect(first.reduce((sum, amount) => sum + amount, 0n)).toBe(150_000_000n);
    expect(allocationCommitment(seed, first)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects missing, short, and malformed seeds', () => {
    expect(() => parseAllocationSeed(undefined)).toThrow();
    expect(() => parseAllocationSeed('abcd')).toThrow();
    expect(() => parseAllocationSeed('z'.repeat(64))).toThrow();
  });
});
