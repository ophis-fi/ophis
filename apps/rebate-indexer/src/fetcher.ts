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
 * Read the order's gross volume-fee rate (bps) from its appData, recipient-guarded
 * and clamped to [1, retail]. Classifies the Ophis partner fee against the backend
 * app_data.rs FeePolicyDeserializer arms and returns one of THREE states (which
 * must NOT collapse, because accrual/dashboard SQL applies
 * COALESCE(volume_fee_bps, GROSS_FEE_BPS) and would credit a NULL at the retail
 * default):
 *
 *   N (1..retail) -- a settled flat Volume fee to Ophis: CIP-75 `{ volumeBps }` or
 *     legacy `{ bps }` with surplusBps/priceImprovementBps/maxVolumeBps all absent
 *     (and not both aliases). Clamped to [1, retail] (a crafted appData can never
 *     claim more than the legacy assumption). This is ~all production volume.
 *
 *   null -- a VALID Surplus `{ surplusBps, maxVolumeBps }` or PriceImprovement
 *     `{ priceImprovementBps, maxVolumeBps }` fee to Ophis. Ophis DID collect a fee,
 *     but this volume-derived indexer cannot compute a surplus/PI amount, so it is
 *     UNKNOWN -> COALESCEs to the retail default and still earns a rebate (the
 *     pre-per-trade behaviour) rather than being zeroed.
 *
 *   0 -- examined, NO settled Ophis fee at ALL: a non-Ophis recipient, an absent /
 *     0-bps fee, or a backend-REJECTED shape (capped `{ volumeBps/bps, maxVolumeBps }`,
 *     both aliases) that never settles. 0 is non-NULL, so COALESCE keeps it 0 and the
 *     trade is credited at ZERO. This is the fix for `{ volumeBps: 5, maxVolumeBps:
 *     50 }` being credited at the retail 10.
 *
 * appData is attacker-controllable, so a crafted array cannot use a decoy
 * `{recipient: attacker, volumeBps: 10}` to over-credit: only Ophis-recipient
 * entries are considered, and a real Volume fee is preferred over a surplus/PI one.
 * The caller additionally leaves NULL for unparseable appData / pre-per-trade rows.
 */
function readVolumeFeeBps(meta: unknown): number | null {
  const pf = (meta as { metadata?: { partnerFee?: unknown } })?.metadata?.partnerFee;
  const entries = Array.isArray(pf) ? pf : [pf];
  let sawOphisNonVolumeFee = false; // a valid surplus / price-improvement Ophis fee
  for (const e of entries) {
    const entry = e as {
      volumeBps?: unknown;
      bps?: unknown;
      surplusBps?: unknown;
      priceImprovementBps?: unknown;
      maxVolumeBps?: unknown;
      recipient?: unknown;
    };
    if (typeof entry?.recipient !== 'string' || entry.recipient.toLowerCase() !== OPHIS_FEE_RECIPIENT) {
      continue; // only the fee that actually pays the Ophis recipient counts
    }
    const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
    // Flat Volume arm: { volumeBps } XOR legacy { bps }, with surplusBps,
    // priceImprovementBps AND maxVolumeBps ALL absent (mirrors the backend). Prefer
    // a real Volume fee over a surplus/PI entry in a multi-entry array.
    const isFlatVolume =
      entry.surplusBps === undefined &&
      entry.priceImprovementBps === undefined &&
      entry.maxVolumeBps === undefined &&
      !(entry.volumeBps !== undefined && entry.bps !== undefined);
    if (isFlatVolume) {
      const raw = entry.volumeBps !== undefined ? entry.volumeBps : entry.bps;
      if (isInt(raw) && raw >= 1) {
        return Math.min(raw, GROSS_FEE_BPS);
      }
    } else if (
      // EXACT backend Surplus arm { surplusBps, maxVolumeBps } or PriceImprovement
      // arm { priceImprovementBps, maxVolumeBps } (integers, mutually exclusive, no
      // volumeBps/bps). A VALID such fee is a real Ophis fee on a CoW-hosted chain
      // (CoW accepts CIP-75 Surplus/PI; only the OP sovereign backend rejects it),
      // but the volume-derived indexer can't compute it -> defer to NULL (retail
      // default) so it still earns. A MALFORMED surplus-ish shape (e.g. missing
      // maxVolumeBps, non-integer, or mixed with volumeBps/bps) is backend-rejected
      // (no settled fee) and must NOT get the retail default -> falls through to 0.
      (isInt(entry.surplusBps) &&
        isInt(entry.maxVolumeBps) &&
        entry.priceImprovementBps === undefined &&
        entry.volumeBps === undefined &&
        entry.bps === undefined) ||
      (isInt(entry.priceImprovementBps) &&
        isInt(entry.maxVolumeBps) &&
        entry.surplusBps === undefined &&
        entry.volumeBps === undefined &&
        entry.bps === undefined)
    ) {
      sawOphisNonVolumeFee = true;
    }
    // else: capped { volumeBps/bps, maxVolumeBps }, both-aliases, or a malformed
    // surplus/PI shape -> backend Errs (no settled fee) -> not creditable; try next.
  }
  // No usable flat Volume fee. A seen surplus/PI Ophis fee -> NULL (retail default,
  // still earns). Otherwise Ophis collected nothing -> 0 (credit zero).
  return sawOphisNonVolumeFee ? null : 0;
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
      // The Ophis AppCode this order is recognized by (stored on the trade row); undefined = drop.
      let appCode: AppCode | undefined;
      let appdataRefCode: string | null = null;
      let volumeFeeBps: number | null = null;
      try {
        const meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
        const lower = (v: unknown): string | undefined => (typeof v === 'string' ? v.toLowerCase() : undefined);
        // Normalize appCode to lowercase BEFORE matching. Emitters have shipped mixed casing —
        // the widget (OPHIS_WIDGET_APP_CODE), the MCP build_order doc, and the frontend appData
        // fallback all tag 'Ophis' (capital) — and a case-SENSITIVE match against the lowercase
        // APP_CODES would SILENTLY drop those orders. Mirror the referral-code lowercasing below.
        const topAppCode = lower(meta?.appCode);
        // Widget embeds: the embedded app promotes the HOST app's appCode to the top-level
        // appData.appCode and DEMOTES the official Ophis code to metadata.widget.appCode (see the
        // frontend's useAppCodeWidgetAware). So an Ophis-backed widget order has topAppCode = the
        // integrator's identifier (NOT 'ophis') and widget.appCode = 'ophis'. Recognize either,
        // otherwise every widget order is silently dropped from Ophis attribution.
        const widgetAppCode = lower(meta?.metadata?.widget?.appCode);
        // Store the Ophis code that matched, so trades.appCode stays typed as AppCode; the
        // integrator's top-level appCode is handled separately as a referral candidate below.
        appCode = isAppCodeOfInterest(topAppCode)
          ? topAppCode
          : isAppCodeOfInterest(widgetAppCode)
            ? widgetAppCode
            : undefined;
        // Per-trade gross fee rate: a rate (1..retail), or 0 when examined with no
        // settled Ophis Volume fee. Stays NULL only on a parse failure below
        // (unknown -> retail default at accrual).
        volumeFeeBps = readVolumeFeeBps(meta);
        // Affiliate attribution. PREFERRED: an explicit metadata.ophisReferrer.code (the SDK/agent
        // path). appData is attacker-controllable, so keep the code ONLY if it matches the registry
        // grammar (mirrors api.ts /^[a-z0-9_-]{3,64}$/), lowercased to match ref_codes, AND only on a
        // CONFIRMED positive Ophis Volume fee (volumeFeeBps > 0) — symmetric with the widget arm
        // below. Without the fee gate, a surplus / price-improvement partnerFee shape to the Ophis
        // recipient reads as NULL and would COALESCE to the retail default at accrual, letting a
        // forged order credit a registered referrer with NO real volume fee. Ophis emitters never
        // emit surplus/PI, so a NULL here means forge-or-unprocessed; a legit SDK order pins a flat
        // volume bps (reads > 0). A malformed/ungated code is dropped to null (the trade then falls
        // back to the wallet-bind path at accrual, which keeps its legacy NULL->retail COALESCE — it
        // is signature-gated, not a forge surface).
        const rawRef = meta?.metadata?.ophisReferrer?.code;
        if (typeof rawRef === 'string' && volumeFeeBps !== null && volumeFeeBps > 0) {
          const code = rawRef.trim().toLowerCase();
          if (/^[a-z0-9_-]{3,64}$/.test(code)) appdataRefCode = code;
        }
        // FALLBACK for WIDGET embeds, which CANNOT carry ophisReferrer (the CoW widget transport
        // serializes only appCode). The integrator's only on-wire identifier is the top-level
        // appCode, so for a widget-recognized order (widget.appCode is Ophis AND the top-level is
        // NOT itself a reserved Ophis code) treat that top-level appCode as the referral candidate,
        // GATED on a CONFIRMED positive Ophis Volume fee (volumeFeeBps > 0). That gate matters: a
        // surplus / price-improvement partnerFee shape to the Ophis recipient reads as NULL here
        // (the volume-derived indexer can't price it) and would otherwise COALESCE to the retail
        // default at accrual — letting a FORGED widget order credit a registered referrer without a
        // real volume fee. Requiring volumeFeeBps > 0 confines this NEW surface to a genuinely paid
        // Ophis Volume fee (a legit @ophis widget pins recipient + a flat volume bps, so it reads
        // > 0 — verified). With the accrual gates (active registered code, self-referral excluded) a
        // forger can at most GIFT a registered referrer at their own fee expense, never steal.
        // ophisReferrer takes precedence (this only fires when appdataRefCode is still null).
        // Both appData-attribution arms (this one and the ophisReferrer arm above) are now gated on
        // volumeFeeBps > 0. The accrual wallet-bind path keeps its legacy NULL->retail COALESCE
        // (signature-gated, not a forge surface); gating that too is a separate decision.
        if (
          appdataRefCode === null &&
          isAppCodeOfInterest(widgetAppCode) &&
          !isAppCodeOfInterest(topAppCode) &&
          typeof topAppCode === 'string' &&
          /^[a-z0-9_-]{3,64}$/.test(topAppCode) &&
          volumeFeeBps !== null &&
          volumeFeeBps > 0
        ) {
          appdataRefCode = topAppCode;
        }
      } catch {
        appCode = undefined;
      }
      if (appCode === undefined) continue; // not an Ophis-recognized order (top-level or widget)

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
            // Backfill the fee rate on a re-encountered row ONLY to UPGRADE a still
            // -NULL pre-per-trade backlog row to a POSITIVE rate. The `> 0` guard is
            // load-bearing: a historical NULL whose appData yields 0 (no Ophis fee)
            // or NULL (surplus/PI) must stay NULL (unknown -> retail) rather than be
            // reclassified to 0 — re-fetching history must not change past accrual.
            // Never clobber an enriched rate; touch no other column (value_usd /
            // priced_at / amounts stay as first indexed). New rows insert normally.
            .onConflictDoUpdate({
              target: schema.trades.tradeUid,
              set: { volumeFeeBps: dsql`excluded.volume_fee_bps` },
              setWhere: dsql`${schema.trades.volumeFeeBps} IS NULL AND excluded.volume_fee_bps > 0`,
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
