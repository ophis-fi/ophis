import { sql } from '../db/index.js';
import { logger } from '../logger.js';
import { runTradeRewards } from './service.js';

const log = logger.child({ module: 'trade-rewards-scheduler' });
const TRADE_REWARDS_LOCK_KEY = 770044;
const TRADE_REWARDS_INTERVAL_MS = 5 * 60 * 1_000;

export async function runScheduledTradeRewards(trigger: 'startup' | 'cron' | 'manual'): Promise<boolean> {
  const lockConn = await sql.reserve();
  let locked = false;
  try {
    const [row] = await lockConn<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${TRADE_REWARDS_LOCK_KEY}) AS locked
    `;
    locked = row?.locked === true;
    if (!locked) {
      log.info({ trigger }, 'trade rewards run already active; skipping');
      return false;
    }

    await sql`
      UPDATE trade_reward_scheduler_state
      SET last_attempt_at = now()
      WHERE singleton = TRUE
    `;
    try {
      const result = await runTradeRewards();
      await sql`
        UPDATE trade_reward_scheduler_state
        SET last_success_at = now(), last_error = NULL
        WHERE singleton = TRUE
      `;
      log.info({ trigger, ...result }, 'trade rewards scheduler complete');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE trade_reward_scheduler_state
        SET last_error = ${message.slice(0, 1_000)}
        WHERE singleton = TRUE
      `;
      log.error({ trigger, err }, 'trade rewards scheduler failed closed');
      throw err;
    }
  } finally {
    if (locked) {
      try {
        await lockConn`SELECT pg_advisory_unlock(${TRADE_REWARDS_LOCK_KEY})`;
      } catch (err) {
        log.error({ err }, 'trade rewards scheduler advisory unlock failed');
      }
    }
    lockConn.release();
  }
}

export function startTradeRewardsScheduler(): void {
  void runScheduledTradeRewards('startup').catch(() => {});
  setInterval(() => {
    void runScheduledTradeRewards('cron').catch(() => {});
  }, TRADE_REWARDS_INTERVAL_MS);
  log.info('trade rewards scheduled: startup + every 5 minutes');
}
