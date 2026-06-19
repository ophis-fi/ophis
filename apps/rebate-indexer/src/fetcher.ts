import { sql as dsql } from 'drizzle-orm';
import { listTrades, getOrder, SUPPORTED_CHAIN_IDS } from './cow/client.js';
import { APP_CODES, type AppCode } from './cow/types.js';
import { GROSS_FEE_BPS } from './affiliate/rates.js';
import { OPHIS_SAFE_ADDRESS } from './safe/addresses.js';
import { logger } from './logger.js';

// The Ophis partner-fee recipient (the Safe). A fee only counts toward the rebate
// base when it actually pays THIS recipient.
const OPHIS_FEE_RECIPIENT = OPHIS_SAFE_ADDRESS.toLowerCase();

const log = logger.child({ module: 'fetcher' });
const PAGE_SIZE = 1_000;

// Minimal DB interface — accepts the real drizzle instance or a test stub.
// When omitted the dedup check is skipped (fine for unit tests).
export interface FetcherDb {
  select(fields: Record<string, unknown>): { from(table: unknown): { where(cond: unknown): { limit(n: number): Promise<unknown[]> } } };
}

export interface FetcherDeps {
  /**
   * Optional drizzle db instance for dedup checks. Omit in unit tests to skip DB calls.
   */
  db?: FetcherDb | null;
}

export interface PendingTrade {
  tradeUid: `0x${string}`;
  chainId: number;
  wallet: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: Date;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  appCode: AppCode;
  /** Referral code from appData (metadata.ophisReferrer.code), normalized +
   *  grammar-validated, or null when absent/malformed. */
  appdataRefCode: string | null;
  /** Gross volume-fee rate (bps) from appData metadata.partnerFee.volumeBps,
   *  clamped to [1, GROSS_FEE_BPS]; null when absent/unreadable (accrual then
   *  treats it as the legacy retail rate). */
  volumeFeeBps: number | null;
}

/**
 * Read the order's gross volume-fee rate (bps) from its appData and clamp it to
 * [1, retail]. appData is attacker-controllable, so two guards apply:
 *   1. RECIPIENT-MATCH: only an entry whose `recipient` is the Ophis Safe sets the
 *      rate. A crafted array cannot put a decoy `{recipient: attacker, volumeBps:
 *      10}` ahead of the real `{recipient: Ophis, volumeBps: 5}` to over-credit;
 *      the decoy is ignored and the actual Ophis fee (5) is used.
 *   2. CLAMP CEILING (retail): bounds any inflated claim to no more than the legacy
 *      flat-retail assumption, so the worst case equals prior behaviour and can
 *      never OVER-credit beyond it; an honest 5 bps SDK / 1 bp stable pair credits
 *      its real, lower rate.
 * Reads the VOLUME policy in either accepted shape: the CIP-75 `{ volumeBps }` OR
 * the legacy `{ bps }` (no surplusBps / priceImprovementBps). The OP backend's
 * app_data.rs deserializer maps BOTH to FeePolicy::Volume (a bare `bps` with no
 * other policy field is a Volume fee), so an SDK/widget/integrator order using
 * `{ bps: 5, recipient: OphisSafe }` must be read as 5 bps, not dropped to null
 * and over-credited at the retail default. A Surplus `{ surplusBps, ... }` or
 * price-improvement `{ priceImprovementBps, ... }` policy is NOT a volume fee, so
 * its presence suppresses the `bps` fallback.
 *
 * `partnerFee` may be a single object or an array (CoW allows multiple). When no
 * Ophis-recipient entry carries a usable Volume rate, returns null and accrual
 * COALESCEs to the retail rate — the same as the pre-per-trade behaviour.
 */
function readVolumeFeeBps(meta: unknown): number | null {
  const pf = (meta as { metadata?: { partnerFee?: unknown } })?.metadata?.partnerFee;
  const entries = Array.isArray(pf) ? pf : [pf];
  for (const e of entries) {
    const entry = e as {
      volumeBps?: unknown;
      bps?: unknown;
      surplusBps?: unknown;
      priceImprovementBps?: unknown;
      recipient?: unknown;
    };
    if (typeof entry?.recipient !== 'string' || entry.recipient.toLowerCase() !== OPHIS_FEE_RECIPIENT) {
      continue; // only the fee that actually pays the Ophis recipient counts
    }
    // CIP-75 `volumeBps`, else the legacy `{ bps }` Volume shape (only when this is
    // NOT a surplus / price-improvement policy — mirrors the backend deserializer).
    let raw = entry.volumeBps;
    if (
      raw === undefined &&
      entry.surplusBps === undefined &&
      entry.priceImprovementBps === undefined
    ) {
      raw = entry.bps;
    }
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
      return Math.min(raw, GROSS_FEE_BPS);
    }
  }
  return null;
}

function isAppCodeOfInterest(code: string | undefined): code is AppCode {
  return code !== undefined && (APP_CODES as readonly string[]).includes(code);
}

/**
 * Fetch one owner's Ophis-tagged trades on one chain.
 *
 * Why owner-scoped: CoW's `GET /api/v1/trades` CANNOT be enumerated globally —
 * called without a filter it returns HTTP 400 ("Must specify exactly one of
 * owner or orderUid"). The previous implementation called it with no owner, so
 * every fetch threw and the `trades` table stayed empty since 2026-05-11. We
 * now scope by `owner` (the wallets we track) and confirm appCode per trade by
 * resolving the linked order's `fullAppData`.
 *
 * block_timestamp comes from the order's `creationDate` rather than an on-chain
 * block lookup: CoW settlement is near-instant and the rebate window is 30 days,
 * so sub-minute skew is irrelevant. This also removes a per-chain RPC dependency
 * and a latent bug (the old lookup queried Gnosis for EVERY chain's block number).
 */
export async function fetchChainTrades(
  chainId: number,
  owner: `0x${string}`,
  deps: FetcherDeps,
): Promise<PendingTrade[]> {
  const out: PendingTrade[] = [];
  const seen = new Set<string>(); // collapse multiple fills of the same order within this run
  let offset = 0;
  while (true) {
    const page = await listTrades({ chainId, owner, offset, limit: PAGE_SIZE });
    if (page.length === 0) break;

    for (const t of page) {
      // One order can settle across multiple fills — CoW returns one trade row
      // per fill, all sharing the same orderUid. We key trades by orderUid and
      // record the order's total executed amount, so process each orderUid once.
      if (seen.has(t.orderUid)) continue;
      seen.add(t.orderUid);

      // Skip if already in DB — cheap key lookup. Skipped when db not provided (e.g. unit tests).
      if (deps.db) {
        // Lazily import sql + schema only when we have a real db instance.
        const { sql, schema } = await import('./db/index.js');
        const already = await deps.db
          .select({ uid: schema.trades.tradeUid, volumeFeeBps: schema.trades.volumeFeeBps })
          .from(schema.trades)
          .where(sql`trade_uid = decode(${t.orderUid.slice(2)}, 'hex')`)
          .limit(1);
        // Skip only a row we've ALREADY enriched with its fee rate. A trade stored
        // by the pre-per-trade code has volume_fee_bps = NULL; re-process it so the
        // insert's onConflictDoUpdate can backfill the rate from appData — otherwise
        // accrual defaults it to retail and over-credits a 5/1 bps order. Once
        // populated it is skipped here (self-healing, one re-fetch per backlog row).
        const row = already[0] as { volumeFeeBps: number | null } | undefined;
        if (row && row.volumeFeeBps !== null) continue;
      }

      // Confirm appCode by fetching the order. We could store unfiltered trades and filter
      // at scoring time, but fetching the order resolves fullAppData (avoids storing trades
      // that turn out to be unrelated to Ophis) and gives us the settlement creationDate.
      const order = await getOrder(chainId, t.orderUid as `0x${string}`);
      let appCode: string | undefined;
      let appdataRefCode: string | null = null;
      let volumeFeeBps: number | null = null;
      try {
        const meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
        appCode = meta?.appCode;
        // Per-trade gross fee rate for fee-accurate accrual (clamped to [1, retail]).
        volumeFeeBps = readVolumeFeeBps(meta);
        // Affiliate attribution: an order may carry metadata.ophisReferrer.code.
        // appData is attacker-controllable, so keep the code ONLY if it matches
        // the registry grammar (mirrors api.ts /^[a-z0-9_-]{3,64}$/); lowercase to
        // match ref_codes. A malformed code is dropped to null (the trade then
        // falls back to the wallet-bind path at accrual time).
        const rawRef = meta?.metadata?.ophisReferrer?.code;
        if (typeof rawRef === 'string') {
          const code = rawRef.trim().toLowerCase();
          if (/^[a-z0-9_-]{3,64}$/.test(code)) appdataRefCode = code;
        }
      } catch {
        appCode = undefined;
      }
      if (!isAppCodeOfInterest(appCode)) continue;

      // Record settled volume from any order in a TERMINAL state, using the
      // order's EXECUTED amounts (total across fills, surplus-inclusive). This
      // includes orders that partially filled and were then cancelled/expired:
      // those fills are real settled CoW volume the rebate must count, and the
      // executed amount is final once terminal. We skip only still-active orders
      // (open/presignaturePending) — they may fill more and re-evaluate on a
      // later run (they aren't stored, so not deduped out). Using the order's
      // executed total (not a single fill) also prevents partial-fill/TWAP
      // undercounting.
      const isTerminal =
        order.status === 'fulfilled' || order.status === 'cancelled' || order.status === 'expired';
      if (!isTerminal) continue;
      const execSell = order.executedSellAmount ?? t.sellAmount;
      const execBuy = order.executedBuyAmount ?? t.buyAmount;
      if (BigInt(execSell) === 0n) continue; // no settled volume (defensive; a /trades row implies a fill)

      out.push({
        tradeUid: t.orderUid as `0x${string}`,
        chainId,
        wallet: t.owner as `0x${string}`,
        blockNumber: BigInt(t.blockNumber),
        // NOTE: order creationDate, not on-chain settlement time. Equal for
        // market orders (all Ophis flow today); a limit/TWAP order created long
        // before it fills could land in the wrong 30-day window — tracked as a
        // follow-up if non-market volume appears.
        blockTimestamp: new Date(order.creationDate),
        sellToken: t.sellToken as `0x${string}`,
        buyToken: t.buyToken as `0x${string}`,
        sellAmount: BigInt(execSell),
        buyAmount: BigInt(execBuy),
        appCode,
        appdataRefCode,
        volumeFeeBps,
      });
    }

    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  if (out.length > 0) log.info({ chainId, owner, fetched: out.length }, 'owner/chain fetch complete');
  return out;
}

/**
 * Pull Ophis-tagged trades for every tracked wallet across every supported chain
 * and upsert them into `trades`. Owners come from the `tracked_wallets` registry,
 * populated by `GET /tier/:wallet` (the swap frontend calls it on wallet connect)
 * and seeded in migration 0001. A single owner/chain failure never aborts the rest.
 */
// Fixed keys for the advisory locks (any constants work; must be distinct).
const FETCHER_LOCK_KEY = 770042;
const PIPELINE_LOCK_KEY = 770043;

/**
 * Run `fn` while holding a PIPELINE-level advisory lock so the two pipeline
 * triggers — the non-blocking startup backfill and the nightly cron — can never
 * overlap. Without this they can race on price/score, and on the 1st the cron's
 * batcher could propose a Safe payout off a matview a concurrent backfill is
 * mid-updating. Returns true if it ran, false if another pipeline held the lock
 * (the caller decides whether a skip matters). Distinct key from the fetcher
 * lock, so runFetcher (FETCHER_LOCK_KEY) nested inside still works.
 */
export async function withPipelineLock(fn: () => Promise<void>): Promise<boolean> {
  const { sql } = await import('./db/index.js');
  const lockConn = await sql.reserve();
  let locked = false;
  try {
    const [row] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${PIPELINE_LOCK_KEY}) AS locked`;
    locked = row?.locked === true;
    if (!locked) {
      log.info('another pipeline run holds the lock; skipping');
      return false;
    }
    await fn();
    return true;
  } finally {
    if (locked) {
      try {
        await lockConn`SELECT pg_advisory_unlock(${PIPELINE_LOCK_KEY})`;
      } catch (err) {
        log.error({ err }, 'pipeline advisory unlock failed');
      }
    }
    lockConn.release();
  }
}

export async function runFetcher(_deps?: FetcherDeps): Promise<{ inserted: number; owners: number }> {
  // Import real db lazily so this module can be loaded without DATABASE_URL set.
  const { db, sql, schema } = await import('./db/index.js');

  // Singleton guard: the fetcher has two triggers (the startup backfill and the
  // nightly cron). If a restart coincides with the cron tick they could overlap
  // and double-fetch / race. A Postgres advisory lock serialises them; if
  // another run holds it, this one no-ops.
  //
  // The lock is SESSION-level, so acquire + release MUST run on the same backend
  // connection — otherwise, on the shared postgres-js pool, the unlock could land
  // on a different connection and leak the lock. So we reserve a dedicated
  // connection for the lock's lifetime; the work itself runs on the pool.
  const lockConn = await sql.reserve();
  let locked = false;
  try {
    const [lockRow] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${FETCHER_LOCK_KEY}) AS locked`;
    locked = lockRow?.locked === true;
    if (!locked) {
      log.info('fetcher already running (advisory lock held); skipping');
      return { inserted: 0, owners: 0 };
    }

    const dbDeps: FetcherDeps = { db: db as unknown as FetcherDb };

    // Bounded, round-robin owner set. `/tier` is public, so tracked_wallets can
    // be spammed with arbitrary addresses; without a cap, runFetcher would do
    // (rows × 11 chains) CoW calls and amplify that into a self-DoS + CoW
    // rate-limit exhaustion. We process at most MAX_OWNERS_PER_RUN per tick,
    // proven wallets (those that already produced an Ophis trade) FIRST so spam
    // can never starve them, then oldest-fetched. Junk is evicted below.
    const MAX_OWNERS_PER_RUN = 500;
    const owners = await sql<{ wallet: string }[]>`
      SELECT '0x' || encode(wallet, 'hex') AS wallet
      FROM tracked_wallets
      WHERE last_fetched IS NULL OR last_fetched < now() - INTERVAL '6 hours'
      -- proven wallets first; then least-recently-fetched (never-fetched first);
      -- then OLDEST registration. The first_seen tiebreaker makes never-fetched
      -- selection FIFO so /tier spam can't starve an older legit wallet that
      -- registered before the flood (they'd otherwise tie on last_fetched=NULL).
      ORDER BY (wallet IN (SELECT wallet FROM trades)) DESC, last_fetched ASC NULLS FIRST, first_seen ASC
      LIMIT ${MAX_OWNERS_PER_RUN}
    `;
    let inserted = 0;
    for (const { wallet } of owners) {
      const owner = wallet as `0x${string}`;
      let ownerOk = true;
      for (const chainId of SUPPORTED_CHAIN_IDS) {
        try {
          const rows = await fetchChainTrades(chainId, owner, dbDeps);
          if (rows.length === 0) continue;
          await db
            .insert(schema.trades)
            .values(
              rows.map((r) => ({
                tradeUid: r.tradeUid,
                chainId: r.chainId,
                wallet: r.wallet,
                blockNumber: r.blockNumber,
                blockTimestamp: r.blockTimestamp,
                sellToken: r.sellToken,
                buyToken: r.buyToken,
                sellAmount: r.sellAmount,
                buyAmount: r.buyAmount,
                appCode: r.appCode,
                partnerFeeWei: null,
                appdataRefCode: r.appdataRefCode,
                volumeFeeBps: r.volumeFeeBps,
              })),
            )
            // Backfill the fee rate on a re-encountered row, and ONLY when it is
            // still NULL (a pre-per-trade backlog row). Never clobber an already
            // enriched rate, and touch no other column — value_usd / priced_at /
            // amounts stay as first indexed. New rows insert normally.
            .onConflictDoUpdate({
              target: schema.trades.tradeUid,
              set: { volumeFeeBps: dsql`excluded.volume_fee_bps` },
              setWhere: dsql`${schema.trades.volumeFeeBps} IS NULL`,
            });
          inserted += rows.length;
        } catch (err) {
          ownerOk = false; // a transient CoW failure must not silently advance the cursor
          log.error({ err, chainId, owner }, 'owner/chain fetch failed'); // single failure does not abort others
        }
      }
      // Always record the attempt; advance last_fetched only when EVERY chain
      // succeeded. A transient CoW outage must not mark the wallet fully fetched
      // (it should retry next run) NOR look like never-attempted junk (the prune
      // distinguishes the two via last_attempt_at).
      if (ownerOk) {
        await sql`UPDATE tracked_wallets SET last_fetched = now(), last_attempt_at = now() WHERE wallet = decode(${owner.slice(2)}, 'hex')`;
      } else {
        await sql`UPDATE tracked_wallets SET last_attempt_at = now() WHERE wallet = decode(${owner.slice(2)}, 'hex')`;
      }
    }

    // NB: pruning lives in pruneStaleWallets() (called nightly), NOT here.
    // runFetcher is invoked in a LOOP by replay-from-genesis; pruning inside it
    // would delete aged, not-yet-refetched wallets before later iterations reach
    // them, silently rebuilding an incomplete ledger.
    log.info({ owners: owners.length, inserted }, 'fetcher complete');
    return { inserted, owners: owners.length };
  } finally {
    // Always runs — even if the lock acquire or unlock throws — so a transient
    // error can't leak the reserved connection. Unlock on the SAME connection
    // that acquired it, and only if we actually got the lock.
    if (locked) {
      try {
        await lockConn`SELECT pg_advisory_unlock(${FETCHER_LOCK_KEY})`;
      } catch (err) {
        log.error({ err }, 'advisory unlock failed');
      }
    }
    lockConn.release();
  }
}

/**
 * Evict tracked wallets that will never yield an Ophis rebate, to bound the
 * registry under public /tier spam. Runs OUT of band (nightly only) — never
 * inside runFetcher — so a replay-from-genesis loop can rebuild the ledger
 * without the prune deleting aged, not-yet-refetched wallets mid-rebuild.
 *
 * Never touches a proven wallet (one with a row in `trades`), and never drops a
 * wallet we haven't given a fair chance to fetch (uses last_attempt_at to tell a
 * transient failure apart from genuine emptiness / deep spam backlog):
 *   - fetched OK but empty     (last_fetched set)                 -> 7 days since registration
 *   - attempted, never succeeded (last_attempt_at set, no fetch)  -> 30 days since the last attempt
 *   - never even attempted      (overflow behind the per-run cap) -> 30 days since registration
 * A wallet still being retried (attempted recently, last_attempt_at < 30d) is
 * NOT pruned, so a CoW outage on its chain can't drop it before it succeeds.
 */
export async function pruneStaleWallets(): Promise<{ pruned: number }> {
  const { sql } = await import('./db/index.js');
  // Hold the SAME advisory lock runFetcher uses, so the prune can NEVER run
  // concurrently with a fetch. Without it, a fetch already holding the lock may
  // have SELECTED an owner but not yet inserted its trades / stamped
  // last_attempt_at; this prune could then delete that row, and the fetch's
  // later `UPDATE tracked_wallets ... WHERE wallet = ...` would match zero rows
  // -> the wallet silently stops refreshing and its volume is lost. If a fetch
  // is running we simply skip pruning this cycle (it's maintenance; the next
  // nightly retries). The lock acquire+release must use one reserved connection.
  const lockConn = await sql.reserve();
  try {
    const [lockRow] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${FETCHER_LOCK_KEY}) AS locked`;
    if (!lockRow?.locked) {
      log.info('fetcher running (advisory lock held); skipping prune this cycle');
      return { pruned: 0 };
    }
    try {
      const pruned = await sql`
        DELETE FROM tracked_wallets
        WHERE wallet NOT IN (SELECT wallet FROM trades)
          AND (
            (last_fetched IS NOT NULL AND first_seen < now() - INTERVAL '7 days')
            OR (last_fetched IS NULL AND last_attempt_at IS NOT NULL AND last_attempt_at < now() - INTERVAL '30 days')
            OR (last_fetched IS NULL AND last_attempt_at IS NULL AND first_seen < now() - INTERVAL '30 days')
          )
      `;
      log.info({ pruned: pruned.count }, 'pruned stale tracked wallets');
      return { pruned: pruned.count };
    } finally {
      await lockConn`SELECT pg_advisory_unlock(${FETCHER_LOCK_KEY})`;
    }
  } finally {
    lockConn.release();
  }
}
