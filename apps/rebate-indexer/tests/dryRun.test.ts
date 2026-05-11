import { describe, it, expect, vi } from 'vitest';
import { isolateBadRecipients, type SimulateFn, type Transfer } from '../src/batch/dryRun.js';

const tf = (id: number, amount: bigint = 1n): Transfer => ({
  to: (`0x${id.toString(16).padStart(40, '0')}`) as `0x${string}`,
  amount,
});

describe('isolateBadRecipients', () => {
  it('returns empty bad list when the full batch simulates successfully', async () => {
    const sim: SimulateFn = vi.fn(async () => ({ ok: true }));
    const { bad } = await isolateBadRecipients([tf(1), tf(2)], sim);
    expect(bad).toEqual([]);
    expect(sim).toHaveBeenCalledTimes(1);
  });

  it('finds a single bad recipient via per-transfer simulation', async () => {
    const bad = tf(2);
    const sim: SimulateFn = vi.fn(async (batch) => {
      // The full batch fails. Then per-tx isolation: only the bad recipient fails.
      if (batch.length > 1) return { ok: false, reason: 'multi-fail' };
      return batch[0]!.to === bad.to ? { ok: false, reason: 'revert' } : { ok: true };
    });
    const result = await isolateBadRecipients([tf(1), bad, tf(3)], sim);
    expect(result.bad.map((t) => t.to)).toEqual([bad.to]);
    expect(result.good.map((t) => t.to)).toEqual([tf(1).to, tf(3).to]);
  });

  it('finds multiple bad recipients', async () => {
    const sim: SimulateFn = vi.fn(async (batch) => {
      if (batch.length > 1) return { ok: false, reason: 'multi-fail' };
      const id = parseInt(batch[0]!.to.slice(2), 16);
      return id % 2 === 0 ? { ok: false, reason: 'revert' } : { ok: true };
    });
    const result = await isolateBadRecipients([tf(1), tf(2), tf(3), tf(4)], sim);
    expect(result.bad.map((t) => t.to)).toEqual([tf(2).to, tf(4).to]);
    expect(result.good.map((t) => t.to)).toEqual([tf(1).to, tf(3).to]);
  });
});
