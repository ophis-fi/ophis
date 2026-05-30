import { listTrades, getOrder, SUPPORTED_CHAIN_IDS } from './cow/client.js';
import { APP_CODES, type AppCode } from './cow/types.js';
import { logger } from './logger.js';

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
          .select({ uid: schema.trades.tradeUid })
          .from(schema.trades)
          .where(sql`trade_uid = decode(${t.orderUid.slice(2)}, 'hex')`)
          .limit(1);
        if (already.length > 0) continue;
      }

      // Confirm appCode by fetching the order. We could store unfiltered trades and filter
      // at scoring time, but fetching the order resolves fullAppData (avoids storing trades
      // that turn out to be unrelated to Ophis) and gives us the settlement creationDate.
      const order = await getOrder(chainId, t.orderUid as `0x${string}`);
      let appCode: string | undefined;
      try {
        const meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
        appCode = meta?.appCode;
      } catch {
        appCode = undefined;
      }
      if (!isAppCodeOfInterest(appCode)) continue;

      // Only record fully-settled orders, and use the order's EXECUTED amounts
      // (total across all fills, surplus-inclusive) rather than one fill's
      // amount — otherwise partial-fill / TWAP orders undercount volume and
      // underpay rebates. A still-filling order is skipped now and picked up on
      // a later run once it settles (it isn't in `trades` yet, so not deduped).
      if (order.status !== 'fulfilled') continue;
      const execSell = order.executedSellAmount ?? t.sellAmount;
      const execBuy = order.executedBuyAmount ?? t.buyAmount;

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
// Fixed key for the singleton advisory lock (any constant works).
const FETCHER_LOCK_KEY = 770042;

export async function runFetcher(_deps?: FetcherDeps): Promise<{ inserted: number }> {
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
  const [lockRow] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${FETCHER_LOCK_KEY}) AS locked`;
  if (!lockRow?.locked) {
    lockConn.release();
    log.info('fetcher already running (advisory lock held); skipping');
    return { inserted: 0 };
  }

  try {
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
      ORDER BY (wallet IN (SELECT wallet FROM trades)) DESC, last_fetched ASC NULLS FIRST
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
              })),
            )
            .onConflictDoNothing();
          inserted += rows.length;
        } catch (err) {
          ownerOk = false; // a transient CoW failure must not silently advance the cursor
          log.error({ err, chainId, owner }, 'owner/chain fetch failed'); // single failure does not abort others
        }
      }
      // Only advance the cursor when EVERY chain succeeded — otherwise a transient
      // CoW outage would mark the wallet fresh and skip it for a full cycle.
      if (ownerOk) {
        await sql`UPDATE tracked_wallets SET last_fetched = now() WHERE wallet = decode(${owner.slice(2)}, 'hex')`;
      }
    }

    // Evict spam: wallets registered via public /tier that produced no Ophis
    // trade within a week. Bounds table growth and the per-run CoW fan-out an
    // attacker could otherwise inflate by mass-registering junk addresses.
    const pruned = await sql`
      DELETE FROM tracked_wallets
      WHERE last_fetched IS NOT NULL
        AND first_seen < now() - INTERVAL '7 days'
        AND wallet NOT IN (SELECT wallet FROM trades)
    `;
    log.info({ owners: owners.length, inserted, pruned: pruned.count }, 'fetcher complete');
    return { inserted };
  } finally {
    // Release on the SAME reserved connection that acquired it, then return it.
    await lockConn`SELECT pg_advisory_unlock(${FETCHER_LOCK_KEY})`;
    lockConn.release();
  }
}
