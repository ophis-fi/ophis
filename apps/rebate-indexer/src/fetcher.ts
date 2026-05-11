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
   * Resolves block_timestamp for a given chain+block. Real implementation hits a public RPC;
   * tests inject a stub. We don't store provider URLs in the fetcher itself — keeps the
   * indexer's chain RPCs configured via env, not hardcoded here.
   */
  blockTimestampLookup(chainId: number, blockNumber: number): Promise<Date>;
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

export async function fetchChainTrades(chainId: number, deps: FetcherDeps): Promise<PendingTrade[]> {
  const out: PendingTrade[] = [];
  let offset = 0;
  while (true) {
    const page = await listTrades({ chainId, offset, limit: PAGE_SIZE });
    if (page.length === 0) break;

    for (const t of page) {
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
      // that turn out to be unrelated to Ophis).
      const order = await getOrder(chainId, t.orderUid as `0x${string}`);
      let appCode: string | undefined;
      try {
        const meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
        appCode = meta?.appCode;
      } catch {
        appCode = undefined;
      }
      if (!isAppCodeOfInterest(appCode)) continue;

      out.push({
        tradeUid: t.orderUid as `0x${string}`,
        chainId,
        wallet: t.owner as `0x${string}`,
        blockNumber: BigInt(t.blockNumber),
        blockTimestamp: await deps.blockTimestampLookup(chainId, t.blockNumber),
        sellToken: t.sellToken as `0x${string}`,
        buyToken: t.buyToken as `0x${string}`,
        sellAmount: BigInt(t.sellAmount),
        buyAmount: BigInt(t.buyAmount),
        appCode,
      });
    }

    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  log.info({ chainId, fetched: out.length }, 'chain fetch complete');
  return out;
}

export async function runFetcher(deps: FetcherDeps): Promise<{ inserted: number }> {
  // Import real db lazily so this module can be loaded without DATABASE_URL set.
  const { db, sql, schema } = await import('./db/index.js');
  const dbDeps: FetcherDeps = { ...deps, db: db as unknown as FetcherDb };
  let inserted = 0;
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    try {
      const rows = await fetchChainTrades(chainId, dbDeps);
      if (rows.length === 0) continue;
      await db.insert(schema.trades).values(
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
      ).onConflictDoNothing();
      inserted += rows.length;
    } catch (err) {
      log.error({ err, chainId }, 'chain fetch failed');                // single chain failure does not abort others
    }
  }
  void sql; // used only via db/index.js import above — suppress lint
  return { inserted };
}
