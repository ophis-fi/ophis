import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pipelineAvailable: true,
  alertClaims: [] as boolean[],
}));

const runTradeRewards = vi.fn(async () => ({ reserved: 0, submitted: 0 }));
const alert = vi.fn(async () => {});
const release = vi.fn();

const lockSql = vi.fn(async (strings: TemplateStringsArray) => {
  const text = strings.join('');
  if (text.includes('pg_try_advisory_lock')) return [{ locked: true }];
  return [];
});

const sql = Object.assign(
  vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('RETURNING TRUE AS claimed')) {
      return state.alertClaims.shift() ? [{ claimed: true }] : [];
    }
    return [];
  }),
  { reserve: vi.fn(async () => Object.assign(lockSql, { release })) },
);

vi.mock('../../src/db/index.js', () => ({ sql }));
vi.mock('../../src/fetcher.js', () => ({
  withPipelineLock: vi.fn(async (fn: () => Promise<void>) => {
    if (!state.pipelineAvailable) return false;
    await fn();
    return true;
  }),
}));
vi.mock('../../src/telegram/alerter.js', () => ({ alerts: { alert } }));
vi.mock('../../src/tradeRewards/service.js', () => ({ runTradeRewards }));

const { runScheduledTradeRewards, startTradeRewardsScheduler } = await import('../../src/tradeRewards/scheduler.js');

describe('trade rewards scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pipelineAvailable = true;
    state.alertClaims = [];
    runTradeRewards.mockResolvedValue({ reserved: 0, submitted: 0 });
  });

  it('defers selection while a trade refresh holds the pipeline lock', async () => {
    state.pipelineAvailable = false;

    await expect(runScheduledTradeRewards('cron')).resolves.toBe(false);

    expect(runTradeRewards).not.toHaveBeenCalled();
    expect(sql.reserve).not.toHaveBeenCalled();
  });

  it('does not race an immediate reward pass against the startup refresh', async () => {
    vi.useFakeTimers();
    try {
      startTradeRewardsScheduler();
      await Promise.resolve();
      expect(runTradeRewards).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(runTradeRewards).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs selection once the trade-refresh lock is available', async () => {
    await expect(runScheduledTradeRewards('cron')).resolves.toBe(true);

    expect(runTradeRewards).toHaveBeenCalledOnce();
    expect(lockSql.mock.calls.some(([strings]) => strings.join('').includes('pg_advisory_unlock'))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('alerts once per persisted throttle window when scheduled runs fail', async () => {
    state.alertClaims = [true, false];
    runTradeRewards.mockRejectedValue(new Error('RPC <unavailable>'));

    await expect(runScheduledTradeRewards('cron')).rejects.toThrow('RPC <unavailable>');
    await expect(runScheduledTradeRewards('cron')).rejects.toThrow('RPC <unavailable>');

    expect(alert).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledWith(
      'trade-rewards',
      expect.stringContaining('RPC &lt;unavailable&gt;'),
    );
  });
});
