import { beforeEach, describe, expect, it, vi } from 'vitest';

// Contention model: `heldFor` is how many try-lock attempts are refused before
// the (simulated) other holder releases. This is the trade-rewards scheduler,
// which takes the SAME pipeline lock every 5 minutes.
const state = vi.hoisted(() => ({ heldFor: 0, attempts: 0 }));

const release = vi.fn();
const lockSql = vi.fn(async (strings: TemplateStringsArray) => {
  const text = strings.join('');
  if (text.includes('pg_try_advisory_lock')) {
    state.attempts += 1;
    return [{ locked: state.attempts > state.heldFor }];
  }
  return [];
});

const sql = Object.assign(
  vi.fn(async () => []),
  { reserve: vi.fn(async () => Object.assign(lockSql, { release })) },
);

vi.mock('../src/db/index.js', () => ({ sql }));

const { withPipelineLock } = await import('../src/fetcher.js');

beforeEach(() => {
  state.heldFor = 0;
  state.attempts = 0;
  vi.clearAllMocks();
});

describe('withPipelineLock', () => {
  it('runs immediately when the lock is free', async () => {
    const fn = vi.fn(async () => {});
    await expect(withPipelineLock(fn)).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // The default MUST stay non-blocking: 12 existing call sites (startup backfill,
  // CLI, the reward scheduler itself) rely on "skip if busy" and would change
  // behaviour if waiting became the default.
  it('skips without waiting when the lock is held and wait is not requested', async () => {
    state.heldFor = 1;
    const fn = vi.fn(async () => {});
    await expect(withPipelineLock(fn)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(state.attempts).toBe(1); // exactly one attempt: no retry loop
  });

  // The regression this guards: before the wait option existed, a trade-rewards run that
  // straddled 02:00 UTC made the nightly pipeline skip its ONLY daily invocation,
  // leaving the reward runs selecting from a trade set nothing had refreshed.
  it('waits out a competing holder and still runs when wait is requested', async () => {
    vi.useFakeTimers();
    try {
      state.heldFor = 2; // busy for the first two attempts, then free
      const fn = vi.fn(async () => {});
      const p = withPipelineLock(fn, { wait: true });
      await vi.advanceTimersByTimeAsync(11_000); // two 5s retry gaps
      await expect(p).resolves.toBe(true);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(state.attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up once the wait window elapses rather than blocking forever', async () => {
    vi.useFakeTimers();
    try {
      state.heldFor = Number.MAX_SAFE_INTEGER; // holder never releases
      const fn = vi.fn(async () => {});
      const p = withPipelineLock(fn, { wait: true });
      await vi.advanceTimersByTimeAsync(16 * 60 * 1_000);
      await expect(p).resolves.toBe(false);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
