import { sql } from '../db/index.js';
import { withPipelineLock } from '../fetcher.js';
import { logger } from '../logger.js';
import { alerts } from '../telegram/alerter.js';
import { runTradeRewards } from './service.js';

const log = logger.child({ module: 'trade-rewards-scheduler' });
// MUST be distinct from every other advisory key in this service:
// 770042 fetcher, 770043 pipeline, 770044 BATCHER, 770045 nightly-pending.
// This was 770044 — the same key as BATCHER_LOCK_KEY, whose own comment requires
// it to be unique. A reward run holding it makes runBatcher's try-lock fail, and
// runBatcher THROWS on that ("aborting to avoid a concurrent cycle"), which would
// abort a monthly Safe proposal. Latent today only because both paths currently
// sit under the pipeline lock; that is an accident of scheduling, not a guarantee.
const TRADE_REWARDS_LOCK_KEY = 770046;
const TRADE_REWARDS_INTERVAL_MS = 5 * 60 * 1_000;
const TRADE_REWARDS_ALERT_INTERVAL = '1 hour';

function escapeTelegramHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function alertScheduledFailure(trigger: 'startup' | 'cron' | 'manual', message: string): Promise<void> {
  // Claim the alert window atomically. This is shared by every replica and
  // survives restarts, unlike an in-memory timer.
  const rows = await sql<{ claimed: boolean }[]>`
    UPDATE trade_reward_scheduler_state
    SET last_alert_at = now()
    WHERE singleton = TRUE
      AND (last_alert_at IS NULL OR last_alert_at <= now() - ${TRADE_REWARDS_ALERT_INTERVAL}::interval)
    RETURNING TRUE AS claimed
  `;
  if (rows[0]?.claimed) {
    await alerts.alert(
      'trade-rewards',
      `Scheduled reward run failed (${trigger}); automatic retries continue every 5 minutes. ` +
        `Latest error: ${escapeTelegramHtml(message.slice(0, 500))}`,
    );
  }
}

async function runWithRewardLock(trigger: 'startup' | 'cron' | 'manual'): Promise<boolean> {
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
      try {
        await alertScheduledFailure(trigger, message);
      } catch (alertErr) {
        log.warn({ err: alertErr }, 'trade rewards scheduler alert failed');
      }
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

export async function runScheduledTradeRewards(trigger: 'startup' | 'cron' | 'manual'): Promise<boolean> {
  let rewardRun = false;
  const refreshIdle = await withPipelineLock(async () => {
    rewardRun = await runWithRewardLock(trigger);
  });
  if (!refreshIdle) {
    log.info({ trigger }, 'trade rewards deferred while trade refresh is active');
    return false;
  }
  return rewardRun;
}

export function startTradeRewardsScheduler(): void {
  setInterval(() => {
    void runScheduledTradeRewards('cron').catch(() => {});
  }, TRADE_REWARDS_INTERVAL_MS);
  // The startup pass is invoked by index.ts only after its trade backfill has
  // released the pipeline lock. Starting a competing pass here could win that
  // lock first and allocate finite tickets from the pre-refresh trade set.
  log.info('trade rewards scheduled: after startup refresh + every 5 minutes');
}
