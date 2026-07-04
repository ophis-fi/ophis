import { sql as dsql } from 'drizzle-orm';
import { listTrades, getOrder, SUPPORTED_CHAIN_IDS } from './cow/client.js';
import { APP_CODES, type AppCode } from './cow/types.js';
import { GROSS_FEE_BPS, OWN_FEE_MAX_BPS } from './affiliate/rates.js';
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
  /** True when volumeFeeBps is authoritative (API row under the owner-allowlist, or an
   *  on-chain-verified decoder row). False for a settle() decoder DISCOVERY row whose
   *  volumeFeeBps is a provisional 0 — the API fetcher may still upgrade it to the real
   *  verified fee; the money path never credits it (it stays at fee=0). */
  feeVerified: boolean;
  /** The integrator's OWN flat-Volume fee rate (bps) from a NON-Ophis partnerFee
   *  entry in appData, clamped to [1, OWN_FEE_MAX_BPS]; null when the order stacked no
   *  such entry. Reporting-only (GET /earnings/:appCode) - NOT part of the Ophis money
   *  path. See readOwnFee. */
  ownFeeBps: number | null;
  /** The integrator's own-fee recipient (lowercased 0x-address) that pairs with
   *  ownFeeBps, for the "where it paid out" link; null when ownFeeBps is null. */
  ownFeeRecipient: `0x${string}` | null;
}

/**
 * Decode the integrator's OWN fee from a settled order's appData: the FIRST
 * partnerFee entry whose recipient is NOT the Ophis Safe and which is a flat Volume
 * fee ({ volumeBps } or legacy { bps }, integer >= 1, with no surplus/PI/cap shape).
 * Integrators STACK their own recipient entry next to the Ophis base entry, so this
 * is how the earnings endpoint attributes what an integrator's own routing earned.
 *
 * Reporting-only: this NEVER feeds the Ophis fee base, the rebate, or the affiliate
 * accrual (those key on volume_fee_bps, the Ophis-recipient entry). appData is
 * attacker-controllable, so the rate is clamped to OWN_FEE_MAX_BPS (a crafted entry
 * cannot inflate the reported figure) and the recipient is shape-validated.
 *
 * Only flat Volume own-fees are decoded: a surplus/price-improvement own-fee is not
 * priceable from volume alone, so it is left null (same limitation as the Ophis-fee
 * classifier). This runs on EVERY chain - the fetcher resolves the full appData for
 * every trade - so there is no hosted-chain attribution gap; only the paid/guaranteed
 * labeling in earnings.ts is sovereign-scoped.
 */
function readOwnFee(meta: unknown): { bps: number; recipient: `0x${string}` } | null {
  const pf = (meta as { metadata?: { partnerFee?: unknown } })?.metadata?.partnerFee;
  const entries = Array.isArray(pf) ? pf : [pf];
  for (const e of entries) {
    const entry = e as {
      volumeBps?: unknown;
      bps?: unknown;
      surplusBps?: unknown;
      priceImprovementBps?: unknown;
      maxVolumeBps?: unknown;
      recipient?: unknown;
    };
    if (typeof entry?.recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry.recipient)) continue;
    const recipient = entry.recipient.toLowerCase() as `0x${string}`;
    if (recipient === OPHIS_FEE_RECIPIENT) continue; // the Ophis base fee -> volume_fee_bps, not own-fee
    const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
    // Flat Volume arm: { volumeBps } XOR legacy { bps }, with surplusBps,
    // priceImprovementBps AND maxVolumeBps ALL absent (mirrors readVolumeFeeBps).
    const isFlatVolume =
      entry.surplusBps === undefined &&
      entry.priceImprovementBps === undefined &&
      entry.maxVolumeBps === undefined &&
      !(entry.volumeBps !== undefined && entry.bps !== undefined);
    if (!isFlatVolume) continue;
    const raw = entry.volumeBps !== undefined ? entry.volumeBps : entry.bps;
    if (isInt(raw) && raw >= 1) {
      return { bps: Math.min(raw, OWN_FEE_MAX_BPS), recipient };
    }
  }
  return null;
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
 * Chains where Ophis runs its OWN dedicated eth-flow contract (NOT the shared
 * canonical CoW eth-flow). On these, an eth-flow order's on-chain `owner` is this
 * contract and the real trader is the order `receiver`. The contract is not shared,
 * so querying it as an "owner" surfaces ONLY Ophis eth-flow trades, which we then
 * attribute to the receiver. Mirrors apps/frontend/libs/common-const/src/common.ts
 * OPHIS_ETHFLOW_OVERRIDES, kept in sync by hand (grep OPHIS_ETHFLOW_OVERRIDES).
 * Paused chains are omitted, but for DIFFERENT reasons: MegaETH (4326) is a zero
 * sentinel (no contract deployed), whereas HyperEVM (999) IS a real deployed
 * eth-flow contract, omitted ONLY because the chain is strategically paused. When
 * HyperEVM un-pauses (mirroring the FE un-pause), ADD 999 here or native-ETH HL
 * rebates will silently never index. The shared canonical eth-flow on CoW-hosted
 * chains (e.g. Base) is NOT here: scanning it would pull all CoW eth-flow traffic,
 * impractical on the free API (tracked as a follow-up).
 */
const OPHIS_ETHFLOW_OWNER_BY_CHAIN: Readonly<Record<number, `0x${string}`>> = Object.freeze({
  // Optimism: Ophis-deployed eth-flow (checksum 0x764fE4aa1FF493cf39931c7923C8ff5837596504, 2026-06-07)
  10: '0x764fe4aa1ff493cf39931c7923c8ff5837596504',
  // Unichain (130): Ophis-deployed eth-flow (checksum 0x38C03729153BCCF6a281DaF41D7C6a14C543F1D7,
  // verified on-chain: EthFlow.cowSwapSettlement() == Ophis Unichain settlement, 2026-06-30). The
  // chain is LIVE, so native-ETH sells must index here or their rebates silently never accrue.
  130: '0x38c03729153bccf6a281daf41d7c6a14c543f1d7',
});
/** Lowercased owner addresses for O(1) "is this an Ophis eth-flow contract" checks. */
const OPHIS_ETHFLOW_OWNERS: ReadonlySet<string> = new Set(Object.values(OPHIS_ETHFLOW_OWNER_BY_CHAIN));

/**
 * The SHARED canonical CoW eth-flow contracts (prod + barn), identical across all
 * CoW-hosted chains (deployed at one CREATE2 address). Sourced from
 * @cowprotocol/sdk-config ETH_FLOW_ADDRESS / BARN_ETH_FLOW_ADDRESS (see
 * apps/frontend/patches/@cowprotocol__sdk-config@2.0.0.patch). Lowercased.
 *
 * The on-chain settle() decoder uses these so a native-ETH order on a hosted chain
 * (e.g. Base) attributes to its `receiver` (the real trader), not the router. The
 * CoW-API fetcher does NOT use them: it cannot enumerate a shared contract as an
 * "owner" (that would pull all of CoW's eth-flow traffic), which is exactly the gap
 * the decoder closes. Keep in sync with the SDK patch by hand (grep ETH_FLOW_ADDRESS).
 */
export const CANONICAL_COW_ETHFLOW_OWNERS: ReadonlySet<string> = new Set([
  '0xba3cb449bd2b4adddbc894d8697f5170800eadec', // prod
  '0xb37add6ac288bd3825a901cba6ec65a89f31b8cc', // barn
]);

/**
 * The eth-flow owner set the ON-CHAIN settle() decoder passes to attributeOrder:
 * the Ophis-dedicated contracts UNION the shared canonical CoW eth-flow contracts.
 * The decoder discovers settlements blind, so it must recognise the shared contract
 * (which the API fetcher never queries) to attribute a hosted-chain native-ETH order
 * to its receiver rather than the router.
 */
export const DECODER_ETHFLOW_OWNERS: ReadonlySet<string> = new Set([
  ...OPHIS_ETHFLOW_OWNERS,
  ...CANONICAL_COW_ETHFLOW_OWNERS,
]);

/**
 * PURE per-trade attribution: given a parsed appData document and the settled-trade
 * context, classify it as an Ophis trade and build the PendingTrade row, or return
 * null to drop it. This is the SINGLE money-path that BOTH the CoW-API fetcher and
 * the on-chain settle() decoder produce trades through, so the recipient guard, the
 * 3-state fee classification, the refcode grammar gates and the eth-flow receiver
 * attribution are byte-identical regardless of source.
 *
 * Callers own SOURCE-specific pre-filters: the API path first checks the order is in
 * a terminal status and derives executed amounts + creationDate; the decoder takes
 * amounts from the Trade event and the timestamp from the block. A settled on-chain
 * Trade event is terminal by construction, so there is no status check here.
 *
 * `ethFlowOwners` is the set of addresses that, when they are the order `owner`, mean
 * an eth-flow order whose real trader is `receiver`. The API fetcher passes the
 * narrow Ophis-dedicated set (default); the decoder passes that UNION the shared
 * canonical CoW eth-flow contracts so hosted-chain native-ETH attributes correctly.
 */
export function attributeOrder(
  meta: unknown,
  ctx: {
    owner: string;
    receiver: string | null | undefined;
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    executedSell: bigint;
    executedBuy: bigint;
    tradeUid: `0x${string}`;
    chainId: number;
    blockNumber: bigint;
    blockTimestamp: Date;
  },
  ethFlowOwners: ReadonlySet<string> = OPHIS_ETHFLOW_OWNERS,
): PendingTrade | null {
  let appCode: AppCode | undefined;
  let appdataRefCode: string | null = null;
  let volumeFeeBps: number | null = null;
  let ownFee: { bps: number; recipient: `0x${string}` } | null = null;
  try {
    const m = meta as {
      appCode?: unknown;
      metadata?: { widget?: { appCode?: unknown }; ophisReferrer?: { code?: unknown } };
    };
    const lower = (v: unknown): string | undefined => (typeof v === 'string' ? v.toLowerCase() : undefined);
    // Normalize appCode to lowercase BEFORE matching (emitters ship mixed casing:
    // widget, MCP build_order, and the FE fallback all tag 'Ophis' capitalized).
    const topAppCode = lower(m?.appCode);
    // Widget embeds promote the HOST app's appCode to the top level and DEMOTE the
    // Ophis code to metadata.widget.appCode. Recognize either, else widget orders drop.
    const widgetAppCode = lower(m?.metadata?.widget?.appCode);
    appCode = isAppCodeOfInterest(topAppCode)
      ? topAppCode
      : isAppCodeOfInterest(widgetAppCode)
        ? widgetAppCode
        : undefined;
    // Per-trade gross fee rate: a rate (1..retail), or 0 when examined with no settled
    // Ophis Volume fee. Stays NULL only on a parse failure (unknown -> retail default).
    volumeFeeBps = readVolumeFeeBps(meta);
    // Integrator OWN-fee (a stacked NON-Ophis partnerFee entry). Reporting-only; never
    // touches the Ophis money path. Independent of the affiliate attribution below.
    ownFee = readOwnFee(meta);
    // PREFERRED affiliate attribution: explicit metadata.ophisReferrer.code (SDK/agent
    // path). appData is attacker-controllable: keep ONLY if it matches the registry
    // grammar, lowercased, AND only on a CONFIRMED positive Ophis Volume fee (>0) so a
    // forged surplus/PI shape can't COALESCE to retail and credit a referrer for free.
    const rawRef = m?.metadata?.ophisReferrer?.code;
    if (typeof rawRef === 'string' && volumeFeeBps !== null && volumeFeeBps > 0) {
      const code = rawRef.trim().toLowerCase();
      if (/^[a-z0-9_-]{3,64}$/.test(code)) appdataRefCode = code;
    }
    // FALLBACK for WIDGET embeds (cannot carry ophisReferrer; only appCode survives the
    // CoW widget transport). The integrator's top-level appCode is the referral
    // candidate when the order is widget-recognized and the top level is not itself a
    // reserved Ophis code, GATED on volumeFeeBps > 0 (same forge guard as above).
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
  if (appCode === undefined) return null; // not an Ophis-recognized order
  if (ctx.executedSell === 0n) return null; // no settled volume (defensive)

  // eth-flow orders settle with owner = the eth-flow contract, NOT the trader.
  // Attribute to the order `receiver` (the real trader). Skip rather than mis-credit
  // an eth-flow order with no usable receiver, and never attribute back to a router.
  let wallet: `0x${string}`;
  if (ethFlowOwners.has(ctx.owner.toLowerCase())) {
    const receiver = ctx.receiver?.trim().toLowerCase();
    if (!receiver || !/^0x[0-9a-f]{40}$/.test(receiver)) return null;
    if (receiver === ctx.owner.toLowerCase() || ethFlowOwners.has(receiver)) return null;
    wallet = receiver as `0x${string}`;
  } else {
    wallet = ctx.owner as `0x${string}`;
  }

  return {
    tradeUid: ctx.tradeUid,
    chainId: ctx.chainId,
    wallet,
    blockNumber: ctx.blockNumber,
    blockTimestamp: ctx.blockTimestamp,
    sellToken: ctx.sellToken,
    buyToken: ctx.buyToken,
    sellAmount: ctx.executedSell,
    buyAmount: ctx.executedBuy,
    appCode,
    appdataRefCode,
    volumeFeeBps,
    // API attribution runs under the owner-allowlist, so its fee is authoritative. The
    // settle() decoder overrides this to false for a discovery (catalog-only) row.
    feeVerified: true,
    ownFeeBps: ownFee?.bps ?? null,
    ownFeeRecipient: ownFee?.recipient ?? null,
  };
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
          .select({
            uid: schema.trades.tradeUid,
            volumeFeeBps: schema.trades.volumeFeeBps,
            feeVerified: schema.trades.feeVerified,
          })
          .from(schema.trades)
          .where(sql`trade_uid = decode(${t.orderUid.slice(2)}, 'hex')`)
          .limit(1);
        // Skip only a row we've ALREADY enriched AUTHORITATIVELY (fee_verified=true with
        // a non-null rate). Re-process otherwise:
        //  - a pre-per-trade row has volume_fee_bps = NULL -> backfill the rate from
        //    appData (otherwise accrual defaults it to retail and over-credits a 5/1 bps
        //    order);
        //  - a settle() decoder DISCOVERY row has fee_verified=false (provisional 0) ->
        //    write the real owner-allowlist-confirmed fee, so a trade the decoder
        //    cataloged before its wallet was tracked is not left permanently at 0.
        // Once authoritatively populated it is skipped here (self-healing, one re-fetch).
        const row = already[0] as { volumeFeeBps: number | null; feeVerified: boolean } | undefined;
        if (row && row.volumeFeeBps !== null && row.feeVerified) continue;
      }

      // Confirm appCode by fetching the order. We could store unfiltered trades and filter
      // at scoring time, but fetching the order resolves fullAppData (avoids storing trades
      // that turn out to be unrelated to Ophis) and gives us the settlement creationDate.
      const order = await getOrder(chainId, t.orderUid as `0x${string}`);

      // Record settled volume only from orders in a TERMINAL state, using the order's
      // EXECUTED amounts (total across fills, surplus-inclusive). Includes orders that
      // partially filled then cancelled/expired (real settled CoW volume; the executed
      // amount is final once terminal). Skip still-active orders (open/presignaturePending):
      // they may fill more and re-evaluate on a later run. This status pre-filter is
      // API-source-specific — an on-chain Trade event is terminal by construction.
      const isTerminal =
        order.status === 'fulfilled' || order.status === 'cancelled' || order.status === 'expired';
      if (!isTerminal) continue;
      const execSell = order.executedSellAmount ?? t.sellAmount;
      const execBuy = order.executedBuyAmount ?? t.buyAmount;

      let meta: unknown;
      try {
        meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
      } catch {
        continue; // unparseable appData -> not attributable
      }

      // Shared money-path attribution (same fn the on-chain decoder uses), so the
      // recipient guard, 3-state fee, refcode gates and eth-flow handling are identical.
      // block_timestamp = order creationDate (CoW settlement is near-instant and the
      // rebate window is 30 days, so sub-minute skew is irrelevant; also avoids a
      // per-chain RPC dependency). NOTE: for a limit/TWAP order created long before it
      // fills this could land in the wrong 30-day window — tracked as a follow-up if
      // non-market volume appears. The default (Ophis-dedicated) eth-flow owner set is
      // correct here: the API path only ever queries those contracts as an owner.
      const trade = attributeOrder(meta, {
        owner: t.owner,
        receiver: order.receiver,
        sellToken: t.sellToken as `0x${string}`,
        buyToken: t.buyToken as `0x${string}`,
        executedSell: BigInt(execSell),
        executedBuy: BigInt(execBuy),
        tradeUid: t.orderUid as `0x${string}`,
        chainId,
        blockNumber: BigInt(t.blockNumber),
        blockTimestamp: new Date(order.creationDate),
      });
      if (trade) out.push(trade);
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
    // (rows × 12 chains) CoW calls and amplify that into a self-DoS + CoW
    // rate-limit exhaustion. We process at most MAX_OWNERS_PER_RUN per tick,
    // proven wallets (those that already produced an Ophis trade) FIRST so spam
    // can never starve them, then oldest-fetched. Junk is evicted below.
    const MAX_OWNERS_PER_RUN = 500;
    const ownerRows = await sql<{ wallet: string }[]>`
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
    // Drop any Ophis eth-flow contract spam-registered via the public /tier
    // endpoint: it is fetched separately as a synthetic owner below (attributing
    // its trades to the receiver, not itself), so processing it as a tracked
    // wallet would double-fetch chain 10 and inflate the `inserted` log count.
    const owners = ownerRows.filter((o) => !OPHIS_ETHFLOW_OWNERS.has(o.wallet.toLowerCase()));
    let inserted = 0;
    // Upsert a batch of fetched trades. Shared by the tracked-wallet loop and the
    // eth-flow synthetic-owner pass below so both apply identical backfill semantics.
    const upsertTrades = async (rows: PendingTrade[]): Promise<number> => {
      if (rows.length === 0) return 0;
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
            feeVerified: r.feeVerified,
            ownFeeBps: r.ownFeeBps,
            ownFeeRecipient: r.ownFeeRecipient,
          })),
        )
        // UPGRADE-only backfill on a re-encountered row, via two disjoint arms (a
        // VERIFIED API write is the only thing that ever updates an existing row;
        // never a downgrade, never a decoder clobber):
        //  (1) self-heal a still-NULL pre-per-trade row to a POSITIVE rate. The `> 0`
        //      is load-bearing: a historical NULL whose appData yields 0/NULL must STAY
        //      NULL (unknown -> retail), so re-fetching history can't reclassify it.
        //  (2) replace a settle() decoder DISCOVERY row (fee_verified=false, provisional
        //      0) with the API's owner-allowlist-confirmed fee + fee_verified=true, at
        //      whatever rate (0 or > 0).
        // A decoder upsert carries excluded.fee_verified=false, so it satisfies NEITHER
        // arm -> it can only INSERT a brand-new row and never overwrites an existing one.
        // Touch no other column (value_usd / priced_at / amounts stay as first indexed).
        // own_fee_bps / own_fee_recipient ride the SAME two UPGRADE-only arms (never a
        // standalone update): a self-healed pre-per-trade row or an upgraded decoder
        // discovery row refreshes the reporting-only own-fee from the authoritative
        // appData alongside the Ophis fee. A plain re-fetch of an already-verified row
        // still matches neither arm, so a stable row's own-fee is not rewritten.
        .onConflictDoUpdate({
          target: schema.trades.tradeUid,
          set: {
            volumeFeeBps: dsql`excluded.volume_fee_bps`,
            feeVerified: dsql`excluded.fee_verified`,
            ownFeeBps: dsql`excluded.own_fee_bps`,
            ownFeeRecipient: dsql`excluded.own_fee_recipient`,
          },
          setWhere: dsql`(${schema.trades.volumeFeeBps} IS NULL AND excluded.volume_fee_bps > 0)
                         OR (${schema.trades.feeVerified} = false AND excluded.fee_verified = true)`,
        });
      return rows.length;
    };
    for (const { wallet } of owners) {
      const owner = wallet as `0x${string}`;
      let ownerOk = true;
      for (const chainId of SUPPORTED_CHAIN_IDS) {
        try {
          const rows = await fetchChainTrades(chainId, owner, dbDeps);
          inserted += await upsertTrades(rows);
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

    // eth-flow synthetic owners: eth-flow orders settle with owner = the Ophis
    // eth-flow contract (not the trader), so they never appear under a tracked
    // wallet's query above. Fetch each dedicated Ophis eth-flow contract as an
    // owner on its own chain; fetchChainTrades attributes each trade to its
    // receiver. Fixed addresses (one per override chain), so no tracked-wallet
    // budget cost, and they are never added to tracked_wallets (fetched directly).
    for (const [chainIdStr, ethFlowOwner] of Object.entries(OPHIS_ETHFLOW_OWNER_BY_CHAIN)) {
      const chainId = Number(chainIdStr);
      if (!SUPPORTED_CHAIN_IDS.includes(chainId)) continue;
      try {
        const rows = await fetchChainTrades(chainId, ethFlowOwner, dbDeps);
        inserted += await upsertTrades(rows);
      } catch (err) {
        log.error({ err, chainId, ethFlowOwner }, 'eth-flow owner fetch failed');
      }
    }

    // On-chain settle() decoder (SUPPLEMENTAL source): closes the rebate gap for
    // hosted-chain native-ETH (shared eth-flow) + contract-owner / EIP-1271 orders
    // that the owner-scoped CoW-API fetch above structurally misses. Runs INSIDE
    // this advisory lock so its per-chain cursor + upserts share the fetcher's
    // critical section. OFF unless SETTLE_DECODER_CHAINS is set (Base-first). Reuses
    // the same upsertTrades (PK-idempotent on trade_uid, so it can never double-count
    // a trade the API fetcher already wrote).
    if (process.env.SETTLE_DECODER_CHAINS) {
      try {
        const { runSettleDecoder } = await import('./cow/onchain.js');
        inserted += await runSettleDecoder({
          sql: sql as unknown as Parameters<typeof runSettleDecoder>[0]['sql'],
          upsertTrades,
        });
      } catch (err) {
        log.error({ err }, 'settle-decoder pass failed');
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

/** Injectable order reader for backfillOwnFee (tests stub it; prod uses getOrder). */
export interface BackfillDeps {
  getOrder?: (chainId: number, uid: `0x${string}`) => Promise<{ fullAppData?: string | null }>;
}

/**
 * ONE-TIME, opt-in backfill of the reporting-only own-fee columns (migration 0014)
 * onto rows indexed BEFORE 0014. The hot fetch loop SKIPS an already-verified row
 * (fetchChainTrades line: volume_fee_bps non-null + fee_verified), and the upsert
 * enriches only NULL-fee / unverified rows, so a VERIFIED pre-0014 trade never gets
 * own_fee_bps / own_fee_recipient and GET /earnings/:appCode under-reports its
 * historical own-fee. This re-resolves each such row's settled appData once and writes
 * ONLY the own-fee columns via a TARGETED UPDATE (never volume_fee_bps / fee_verified),
 * so the verified Ophis fee and its idempotence are untouched. The UPDATE re-checks
 * own_fee_bps IS NULL so a concurrent write is never clobbered.
 *
 * Run OUT of band (the backfill-own-fee CLI command), never inside runFetcher: it
 * re-fetches one order per scanned row, so it is not a per-run CoW load. Bounded by
 * `limit`; a row with no stacked own-fee is left NULL and simply re-scanned on a later
 * run (the pre-0014 backlog is finite and does not grow, so a few bounded runs drain it).
 */
export async function backfillOwnFee(
  limit = 500,
  deps: BackfillDeps = {},
): Promise<{ scanned: number; updated: number }> {
  const { sql } = await import('./db/index.js');
  const fetchOrder = deps.getOrder ?? getOrder;
  // Only VERIFIED, fee-paying rows still missing own_fee: exactly the pre-0014 gap.
  const rows = await sql<{ uid_hex: string; chain_id: number }[]>`
    SELECT encode(trade_uid, 'hex') AS uid_hex, chain_id
    FROM trades
    WHERE own_fee_bps IS NULL
      AND fee_verified = true
      AND volume_fee_bps IS NOT NULL
    ORDER BY fetched_at ASC
    LIMIT ${limit}
  `;
  let scanned = 0;
  let updated = 0;
  for (const r of rows) {
    scanned++;
    if (!SUPPORTED_CHAIN_IDS.includes(r.chain_id)) continue;
    const uid = `0x${r.uid_hex}` as `0x${string}`;
    let order: { fullAppData?: string | null };
    try {
      order = await fetchOrder(r.chain_id, uid);
    } catch (err) {
      log.warn({ err, chainId: r.chain_id, uid }, 'backfill-own-fee: getOrder failed; skipping row');
      continue;
    }
    let meta: unknown;
    try {
      meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
    } catch {
      continue; // unparseable appData -> leave NULL
    }
    const own = readOwnFee(meta);
    if (!own) continue; // no stacked own-fee entry -> genuinely NULL, nothing to write
    const res = await sql`
      UPDATE trades
      SET own_fee_bps = ${own.bps},
          own_fee_recipient = decode(${own.recipient.slice(2)}, 'hex')
      WHERE trade_uid = decode(${r.uid_hex}, 'hex') AND own_fee_bps IS NULL
    `;
    updated += res.count ?? 0;
  }
  log.info({ scanned, updated }, 'backfill-own-fee complete');
  return { scanned, updated };
}
