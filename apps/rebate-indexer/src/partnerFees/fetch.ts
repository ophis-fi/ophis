import { createPublicClient, http } from 'viem';
import { attributePartnerFees } from './parsePartnerFees.js';
import { alerts } from '../telegram/alerter.js';
import { logger } from '../logger.js';

// db is imported lazily (like migrate.ts / pricer.ts) so the pure config helpers
// (resolvePartnerFeeFeeds, assertFeedsConfigFeeFree) can be loaded without DATABASE_URL set.
async function getSql() {
  return (await import('../db/index.js')).sql;
}

/** Resolve a per-chain RPC URL for block-timestamp enrichment (reuses the settle-decoder env). */
const DEFAULT_RPC: Record<number, string> = { 10: 'https://mainnet.optimism.io', 130: 'https://mainnet.unichain.org' };
function partnerFeeRpc(chainId: number): string {
  return process.env[`PARTNER_FEE_RPC_URL_${chainId}`] ?? process.env[`SETTLE_RPC_URL_${chainId}`] ?? DEFAULT_RPC[chainId] ?? 'https://mainnet.optimism.io';
}

/** Fetch a settlement block's UTC timestamp, or null on failure (retried next run). Injectable. */
export type BlockTimestampFetcher = (chainId: number, blockNumber: bigint) => Promise<Date | null>;
async function defaultBlockTimestamp(chainId: number, blockNumber: bigint): Promise<Date | null> {
  try {
    const client = createPublicClient({ transport: http(partnerFeeRpc(chainId)) });
    const block = await client.getBlock({ blockNumber });
    return new Date(Number(block.timestamp) * 1000);
  } catch {
    return null;
  }
}

const log = logger.child({ module: 'partner-fee-fetch' });

// Cursor poller over the restricted partner-fee accrual feed (partner-fees Phase B).
// Consumes GET /restricted/api/v1/partner_fees (Phase A, PR #926): a (block_number,
// log_index)-cursored feed of settled fee-bearing trades with the full appData, returning
// `{ trades, nextBlock?, nextLogIndex? }`. This poller attributes each trade's collected
// protocolFeeAmounts to its NON-Ophis partner recipients (parsePartnerFees.ts) and inserts
// idempotent partner_fee_trades rows. It NEVER prices or pays -- pricing is the nightly
// pricer, payout is the monthly batcher.

/** Page size per feed request. The feed caps at 10_000; 1_000 keeps memory bounded. */
const FEED_LIMIT = 1_000;
/** Safety bound on pages per run so a runaway/looping feed can't spin forever. */
const MAX_PAGES_PER_RUN = 10_000;

/** One raw trade row from the feed (camelCase, string amounts) -- mirrors PartnerFeeFeedRow. */
interface FeedTrade {
  blockNumber: number;
  logIndex: number;
  orderUid: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  protocolFeeAmounts: string[];
  protocolFeeTokens: string[];
  fullAppData: string | null;
}

interface FeedResponse {
  trades: FeedTrade[];
  nextBlock?: number;
  nextLogIndex?: number;
}

/** A configured feed: one Ophis-operated chain's restricted endpoint. */
export interface PartnerFeeFeed {
  readonly chainId: number;
  readonly url: string;
}

// Chains ASSERTED to have an EMPTY autopilot `[fee-policies]` section, so the ONLY protocol
// fees on a settled trade are the appData `partnerFee` Volume entries. The positional
// attribution (parsePartnerFees.ts) maps `protocolFeeAmounts[i]` to the i-th kept partnerFee
// entry, which is money-safe ONLY under this invariant: a config-driven protocol fee would
// PREPEND an extra slot and could, when a partner entry is ALSO dropped (unregistered /
// suspended), coincidentally match the slot count and MIS-ATTRIBUTE a config fee to a real
// partner. The exact-count guard alone does not catch that coincidence, so the poller REFUSES
// (fail loud) to poll any chain not asserted here. This set MUST be kept in sync with the
// backend autopilot configs (`infra/<chain>/configs/autopilot.toml` `[fee-policies]`); adding
// a chain here without verifying its `[fee-policies]` is EMPTY is a money-path regression.
// Reading the remote autopilot config from the indexer is impractical (separate deployment),
// so this asserted set is the feasible fail-closed enforcement -- mirroring the fail-closed
// SOVEREIGN_OWN_FEE_RECIPIENTS allowlist pattern (ownFee/recipients.ts).
const CONFIG_FEE_FREE_CHAINS: ReadonlySet<number> = new Set<number>([
  10, //  Optimism  (autopilot.toml [fee-policies] verified empty, 2026-07)
  130, // Unichain  (sovereign, same empty [fee-policies] posture)
]);

/**
 * Fail loud if any fed chain is NOT asserted config-fee-free. Called on every poll (over both
 * env-resolved and test-injected feeds), so a future config change or a second fed chain with a
 * config protocol fee can never silently shift partner slots off index and mis-attribute.
 */
export function assertFeedsConfigFeeFree(feeds: readonly PartnerFeeFeed[]): void {
  for (const f of feeds) {
    if (!CONFIG_FEE_FREE_CHAINS.has(f.chainId)) {
      throw new Error(
        `partner-fee feed: chain ${f.chainId} is NOT asserted config-fee-free; refusing to poll. ` +
          `The positional fee->partner attribution is only money-safe when the chain's autopilot ` +
          `[fee-policies] is EMPTY. Verify it, then add ${f.chainId} to CONFIG_FEE_FREE_CHAINS in ` +
          `src/partnerFees/fetch.ts. (fail-closed: never mis-attribute a config fee to a partner)`,
      );
    }
  }
}

/**
 * Parse `PARTNER_FEE_FEED_URLS` into per-chain feeds. Format: comma-separated
 * `<chainId>=<url>` (e.g. `10=https://rebates.ophis.fi/restricted/api/v1/partner_fees`). A
 * bare URL with no `chainId=` prefix defaults to Optimism (10), the launch chain. Unset/empty
 * => no feeds (the feature stays inert until configured). Throws on a malformed entry
 * (fail-loud, mirroring the other money-path env parsers).
 */
export function resolvePartnerFeeFeeds(raw = process.env.PARTNER_FEE_FEED_URLS): PartnerFeeFeed[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  const feeds: PartnerFeeFeed[] = [];
  const seen = new Set<number>();
  for (const part of trimmed.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    let chainId: number;
    let url: string;
    if (eq === -1) {
      chainId = 10; // bare URL -> Optimism launch chain
      url = entry;
    } else {
      chainId = Number(entry.slice(0, eq));
      url = entry.slice(eq + 1).trim();
    }
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error(`PARTNER_FEE_FEED_URLS: invalid chainId in "${entry}" (use "<chainId>=<url>")`);
    }
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`PARTNER_FEE_FEED_URLS: invalid url in "${entry}" (must be http(s))`);
    }
    if (seen.has(chainId)) {
      throw new Error(`PARTNER_FEE_FEED_URLS: duplicate chainId ${chainId} (one feed per chain)`);
    }
    seen.add(chainId);
    feeds.push({ chainId, url });
  }
  assertFeedsConfigFeeFree(feeds); // fail loud on a chain not asserted config-fee-free
  return feeds;
}

export type FeedFetcher = (feed: PartnerFeeFeed, minBlock: bigint, minLogIndex: bigint, limit: number) => Promise<FeedResponse>;

/** Default HTTP fetcher for the restricted feed. Injectable so tests use an msw mock or stub. */
async function defaultFeedFetcher(feed: PartnerFeeFeed, minBlock: bigint, minLogIndex: bigint, limit: number): Promise<FeedResponse> {
  const u = new URL(feed.url);
  u.searchParams.set('min_block', minBlock.toString());
  u.searchParams.set('min_log_index', minLogIndex.toString());
  u.searchParams.set('limit', String(limit));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    // The feed lives under /restricted/ behind a WAF; pass an optional shared secret so the
    // poller is authenticated at the edge without leaking it into the URL/logs.
    const auth = process.env.PARTNER_FEE_FEED_AUTH?.trim();
    if (auth) headers.authorization = auth;
    const res = await fetch(u, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`partner-fee feed ${feed.url} returned HTTP ${res.status}`);
    return (await res.json()) as FeedResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the persisted cursor for a chain (defaults to genesis on first run). */
async function loadCursor(chainId: number): Promise<{ block: bigint; logIndex: bigint }> {
  const sql = await getSql();
  const [row] = await sql<{ next_block: string; next_log_index: string }[]>`
    SELECT next_block::text AS next_block, next_log_index::text AS next_log_index
    FROM partner_fee_cursor WHERE chain_id = ${chainId}
  `;
  return { block: BigInt(row?.next_block ?? '0'), logIndex: BigInt(row?.next_log_index ?? '0') };
}

/** Persist the resume cursor for a chain (upsert). */
async function saveCursor(chainId: number, block: bigint, logIndex: bigint): Promise<void> {
  const sql = await getSql();
  await sql`
    INSERT INTO partner_fee_cursor (chain_id, next_block, next_log_index, updated_at)
    VALUES (${chainId}, ${block.toString()}, ${logIndex.toString()}, now())
    ON CONFLICT (chain_id) DO UPDATE
      SET next_block = EXCLUDED.next_block, next_log_index = EXCLUDED.next_log_index, updated_at = now()
  `;
}

/** Insert one attributed partner-fee trade row (idempotent on the (trade_uid, recipient) PK). */
async function insertTrade(row: {
  tradeUid: `0x${string}`;
  recipient: `0x${string}`;
  chainId: number;
  blockNumber: bigint;
  logIndex: bigint;
  volumeBps: number;
  feeToken: `0x${string}`;
  feeAmount: bigint;
}): Promise<void> {
  const sql = await getSql();
  await sql`
    INSERT INTO partner_fee_trades
      (trade_uid, recipient, chain_id, block_number, log_index, volume_bps, fee_token, fee_amount)
    VALUES (
      decode(${row.tradeUid.slice(2)}, 'hex'),
      decode(${row.recipient.slice(2)}, 'hex'),
      ${row.chainId}, ${row.blockNumber.toString()}, ${row.logIndex.toString()},
      ${row.volumeBps}, decode(${row.feeToken.slice(2)}, 'hex'), ${row.feeAmount.toString()}
    )
    ON CONFLICT (trade_uid, recipient, chain_id, block_number, log_index) DO NOTHING
  `;
}

export interface PartnerFeeFetchDeps {
  /** Feeds to poll (default: parsed from PARTNER_FEE_FEED_URLS). */
  readonly feeds?: readonly PartnerFeeFeed[];
  /** Injected HTTP fetcher (default: defaultFeedFetcher). */
  readonly fetcher?: FeedFetcher;
  /** Injected block-timestamp fetcher (default: on-chain getBlock). */
  readonly blockTimestamp?: BlockTimestampFetcher;
}

/** Rows to enrich per run so a large backlog is bounded (re-runs drain the rest). */
const TIMESTAMP_BACKFILL_LIMIT = 5_000;

/**
 * Enrich `block_timestamp` for settlement rows that lack it, so the monthly accrual can apply a
 * calendar-month cutoff. One RPC per distinct (chain, block); a failure leaves the row null and
 * is retried next run (the accrual holds null-timestamp rows out until enriched -- fail-safe, so
 * a trade is never attributed to the wrong month).
 */
async function backfillBlockTimestamps(fetcher: BlockTimestampFetcher): Promise<{ enriched: number }> {
  const sql = await getSql();
  const rows = await sql<{ chain_id: number; block_number: string }[]>`
    SELECT DISTINCT chain_id, block_number::text AS block_number
    FROM partner_fee_trades WHERE block_timestamp IS NULL
    ORDER BY chain_id, block_number
    LIMIT ${TIMESTAMP_BACKFILL_LIMIT}
  `;
  let enriched = 0;
  for (const r of rows) {
    const ts = await fetcher(r.chain_id, BigInt(r.block_number));
    if (!ts) continue;
    await sql`
      UPDATE partner_fee_trades SET block_timestamp = ${ts.toISOString()}
      WHERE chain_id = ${r.chain_id} AND block_number = ${r.block_number} AND block_timestamp IS NULL
    `;
    enriched++;
  }
  return { enriched };
}

/**
 * Poll every configured feed from its cursor to the drain point, attributing + inserting
 * partner-fee trades. Idempotent (ON CONFLICT DO NOTHING) so an overlapping re-read never
 * duplicates. Advances the cursor to `(lastTrade.block, lastTrade.logIndex + 1)` after every
 * page, so a crash mid-run resumes exactly after the last durably-inserted trade -- no trade
 * in a partially-returned block is ever skipped OR double-counted. Skipped (ambiguous)
 * attributions are surfaced via a capped alert; they are NOT inserted (fail-safe under-count).
 */
export async function runPartnerFeeFetch(deps: PartnerFeeFetchDeps = {}): Promise<{ inserted: number; skipped: number; enriched: number }> {
  const feeds = deps.feeds ?? resolvePartnerFeeFeeds();
  const fetcher = deps.fetcher ?? defaultFeedFetcher;
  // Re-assert even for injected feeds (resolvePartnerFeeFeeds already asserts the env path), so a
  // test or a direct caller can never bypass the config-fee-free guard.
  assertFeedsConfigFeeFree(feeds);
  if (feeds.length === 0) {
    log.debug('no partner-fee feeds configured (PARTNER_FEE_FEED_URLS unset); skipping');
    return { inserted: 0, skipped: 0, enriched: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  const skippedExamples: string[] = [];

  for (const feed of feeds) {
    let cursor = await loadCursor(feed.chainId);
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const resp = await fetcher(feed, cursor.block, cursor.logIndex, FEED_LIMIT);
      const trades = resp.trades ?? [];
      for (const t of trades) {
        const result = attributePartnerFees(t);
        if (result.skipped) {
          skipped++;
          if (skippedExamples.length < 10) skippedExamples.push(`${t.orderUid} (${result.reason})`);
          log.warn({ orderUid: t.orderUid, reason: result.reason, chainId: feed.chainId }, 'partner-fee attribution skipped (ambiguous slot mapping); not accrued');
          continue;
        }
        for (const a of result.attributions) {
          await insertTrade({
            tradeUid: t.orderUid as `0x${string}`,
            recipient: a.recipient,
            chainId: feed.chainId,
            blockNumber: BigInt(t.blockNumber),
            logIndex: BigInt(t.logIndex),
            volumeBps: a.volumeBps,
            feeToken: a.feeToken,
            feeAmount: a.feeAmount,
          });
          inserted++;
        }
      }
      // Advance the cursor to just AFTER the last processed trade, so a mid-run crash resumes
      // without re-reading (idempotent anyway) or skipping the block's remaining trades.
      if (trades.length > 0) {
        const last = trades[trades.length - 1]!;
        cursor = { block: BigInt(last.blockNumber), logIndex: BigInt(last.logIndex) + 1n };
        await saveCursor(feed.chainId, cursor.block, cursor.logIndex);
      }
      // A full page sets nextBlock; its absence means the window is drained.
      if (resp.nextBlock === undefined || resp.nextBlock === null) break;
      if (page === MAX_PAGES_PER_RUN - 1) {
        log.warn({ chainId: feed.chainId }, 'partner-fee fetch hit the per-run page cap; will continue next run');
      }
    }
  }

  if (skipped > 0) {
    void alerts
      .alert(
        'partner-fee-fetch',
        `${skipped} partner-fee trade(s) this run had an AMBIGUOUS fee->recipient mapping (a dropped/suspended entry or unexpected slot) and were NOT accrued (fail-safe under-count). Review: ${skippedExamples.join(', ')}${skipped > skippedExamples.length ? `, +${skipped - skippedExamples.length} more` : ''}.`,
      )
      .catch((e) => log.warn({ err: e }, 'partner-fee skip alert failed'));
  }

  // Enrich settlement block timestamps (for the monthly accrual's calendar-month cutoff).
  // Best-effort: a failure leaves rows null and is retried next run; the accrual holds
  // null-timestamp rows out until enriched, so nothing is mis-attributed to the wrong month.
  let enriched = 0;
  try {
    ({ enriched } = await backfillBlockTimestamps(deps.blockTimestamp ?? defaultBlockTimestamp));
  } catch (err) {
    log.warn({ err }, 'partner-fee block-timestamp backfill failed (retried next run)');
  }

  log.info({ inserted, skipped, enriched, feeds: feeds.length }, 'partner-fee fetch complete');
  return { inserted, skipped, enriched };
}
