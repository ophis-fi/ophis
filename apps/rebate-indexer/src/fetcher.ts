import { sql as dsql } from 'drizzle-orm';
import { listTrades, getOrder, SUPPORTED_CHAIN_IDS } from './cow/client.js';
import { APP_CODES, type AppCode, type CowTrade } from './cow/types.js';
import {
  HISTORICAL_OPHIS_FEE_MAX_BPS,
  OWN_FEE_MAX_BPS,
  SOVEREIGN_CHAIN_IDS,
  affiliateFeeBpsForOrderCreatedAt,
  undecodedFeeFallbackBpsForOrderCreatedAt,
} from './affiliate/rates.js';
import { OPHIS_SAFE_ADDRESS } from './safe/addresses.js';
import { logger } from './logger.js';
import { getRpcClient } from './rpc/client.js';
import { PRODUCTION_CHAIN_IDS } from './stats-page.js';

// The Ophis partner-fee recipient (the Safe). A fee only counts toward the rebate
// base when it actually pays THIS recipient.
const OPHIS_FEE_RECIPIENT = OPHIS_SAFE_ADDRESS.toLowerCase();

const log = logger.child({ module: 'fetcher' });
const PAGE_SIZE = 1_000;
const DEFILLAMA_CHAIN_IDS = new Set(PRODUCTION_CHAIN_IDS);
export const FETCHER_MAX_OWNERS_PER_RUN = 500;

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
  /** Optional fill sink used by the production fetcher for DefiLlama reporting. */
  defillamaFills?: PendingDefiLlamaFill[];
  /** True when this exact settlement fill is already persisted. */
  hasDefiLlamaFill?: (fill: Pick<PendingDefiLlamaFill, 'chainId' | 'blockNumber' | 'logIndex' | 'tradeUid'>) => Promise<boolean>;
  /** Settlement block timestamp resolver; injected in tests. */
  getSettlementTimestamp?: (chainId: number, blockNumber: bigint) => Promise<Date>;
}

export interface PendingDefiLlamaFill {
  chainId: number;
  blockNumber: bigint;
  logIndex: number;
  tradeUid: `0x${string}`;
  transactionHash: `0x${string}`;
  /** Actual trader; for eth-flow this is the receiver, never the router owner. */
  userAddress: `0x${string}`;
  settlementTimestamp: Date;
  sellToken: `0x${string}`;
  sellAmount: bigint;
  buyToken: `0x${string}`;
  buyAmount: bigint;
  volumeFeeBps: number | null;
  /** Reporting-only effective Ophis fee rate, including assessed improvement.
   * Decimal string preserves fractional bps and never funds affiliate payouts. */
  assessedFeeBps: string | null;
  feeVerified: boolean;
}

/**
 * Insert settlement fills, UPGRADING a provisional decoder row in place. The
 * decoder writes DISCOVERY fills with fee_verified=false (ToB B1: no decoder-
 * derived fee reaches reporting); when the owner-scoped API later serves the
 * authoritative fee for the same (chain, block, logIndex, uid), that verified
 * write must replace the provisional fee fields or the fill stays permanently
 * excluded from computeDefiLlamaDay. Upgrade-only (setWhere): a verified row is
 * never downgraded, and a re-scanned discovery row can never overwrite one.
 * Exported for the int test; runFetcher's flush is the production caller.
 */
export async function upsertDefillamaFills(rows: PendingDefiLlamaFill[]): Promise<void> {
  if (rows.length === 0) return;
  // Deduplicate on the composite conflict key first: one INSERT ... ON CONFLICT
  // DO UPDATE statement cannot affect the same target row twice (Postgres raises
  // a cardinality violation), and one batch CAN legitimately carry duplicates,
  // e.g. an offset-paged owner fetch where a trade settling between page
  // requests shifts a boundary row into both pages (the old DO NOTHING path
  // absorbed this silently). A VERIFIED copy wins over a provisional one so the
  // in-batch pick can never lose the authoritative fee.
  const byKey = new Map<string, PendingDefiLlamaFill>();
  for (const row of rows) {
    const key = `${row.chainId}:${row.blockNumber}:${row.logIndex}:${row.tradeUid}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.feeVerified && row.feeVerified)) byKey.set(key, row);
  }
  const { db, schema } = await import('./db/index.js');
  await db
    .insert(schema.defillamaFills)
    .values([...byKey.values()])
    .onConflictDoUpdate({
      target: [
        schema.defillamaFills.chainId,
        schema.defillamaFills.blockNumber,
        schema.defillamaFills.logIndex,
        schema.defillamaFills.tradeUid,
      ],
      set: {
        transactionHash: dsql`COALESCE(${schema.defillamaFills.transactionHash}, excluded.transaction_hash)`,
        // Early reporting rows predate the per-fill buy side. The exact-UID/on-chain
        // source can complete those nullable legacy columns without rewriting an
        // already-persisted immutable value.
        buyToken: dsql`COALESCE(${schema.defillamaFills.buyToken}, excluded.buy_token)`,
        buyAmount: dsql`COALESCE(${schema.defillamaFills.buyAmount}, excluded.buy_amount)`,
        // A verified API/exact-UID write is authoritative for user attribution
        // and may correct a legacy eth-flow router copied into this field.
        userAddress: dsql`CASE WHEN excluded.fee_verified
          THEN excluded.user_address
          ELSE COALESCE(${schema.defillamaFills.userAddress}, excluded.user_address) END`,
        volumeFeeBps: dsql`CASE WHEN excluded.fee_verified
          THEN excluded.volume_fee_bps ELSE ${schema.defillamaFills.volumeFeeBps} END`,
        assessedFeeBps: dsql`COALESCE(excluded.assessed_fee_bps, ${schema.defillamaFills.assessedFeeBps})`,
        feeVerified: dsql`${schema.defillamaFills.feeVerified} OR excluded.fee_verified`,
      },
      setWhere: dsql`(${schema.defillamaFills.feeVerified} = false AND excluded.fee_verified = true)
                     OR (${schema.defillamaFills.assessedFeeBps} IS NULL AND excluded.assessed_fee_bps IS NOT NULL)
                     OR (excluded.fee_verified = true AND excluded.assessed_fee_bps IS NOT NULL
                       AND ${schema.defillamaFills.assessedFeeBps} IS DISTINCT FROM excluded.assessed_fee_bps)
                     OR ${schema.defillamaFills.transactionHash} IS NULL
                     OR ${schema.defillamaFills.userAddress} IS NULL
                     OR ${schema.defillamaFills.buyToken} IS NULL
                     OR ${schema.defillamaFills.buyAmount} IS NULL
                     OR (excluded.fee_verified = true
                       AND ${schema.defillamaFills.userAddress} IS DISTINCT FROM excluded.user_address)`,
    });
}

async function getSettlementTimestamp(chainId: number, blockNumber: bigint): Promise<Date> {
  const block = await getRpcClient(chainId).getBlock({ blockNumber });
  return new Date(Number(block.timestamp) * 1000);
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
  /** Basket id from appData (metadata.ophisBasket.id), grammar-validated (32-hex),
   *  or null when the order was not a basket leg. Pure analytics passthrough:
   *  groups the legs of one basket for after-the-fact volume measurement. */
  basketId: string | null;
  /** Affiliate-liability base rate from appData. Historical orders retain their
   *  decoded rate; orders created after the canonical cutover are capped at 1 bp. */
  volumeFeeBps: number | null;
  /** API-derived fallback for an undecodable fee, based on order.creationDate.
   * NULL on decoder-only rows; affiliate accrual holds those until enrichment. */
  undecodedFeeFallbackBps: number | null;
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
 * must NOT collapse, because accrual/dashboard SQL applies the API-persisted
 * order-creation policy marker to NULL):
 *
 *   N (1..retail) -- a settled flat Volume fee to Ophis: CIP-75 `{ volumeBps }` or
 *     legacy `{ bps }` with surplusBps/priceImprovementBps/maxVolumeBps all absent
 *     (and not both aliases). Clamped to [1, retail] (a crafted appData can never
 *     claim more than the legacy assumption). This is ~all production volume.
 *
 *   null -- a VALID Surplus `{ surplusBps, maxVolumeBps }` or PriceImprovement
 *     `{ priceImprovementBps, maxVolumeBps }` fee to Ophis. Ophis DID collect a fee,
 *     but this volume-derived indexer cannot compute a surplus/PI amount, so it is
 *     UNKNOWN -> receives the cutover-appropriate fallback rather than being zeroed.
 *
 *   0 -- examined, NO settled Ophis fee at ALL: a non-Ophis recipient, an absent /
 *     0-bps fee, or a backend-REJECTED shape (capped `{ volumeBps/bps, maxVolumeBps }`,
 *     both aliases) that never settles. 0 is non-NULL, so COALESCE keeps it 0 and the
 *     trade is credited at ZERO. This is the fix for `{ volumeBps: 5, maxVolumeBps:
 *     50 }` being credited at the retail 10.
 *
 * appData is attacker-controllable, so a crafted array cannot use a decoy
 * `{recipient: attacker, volumeBps: 10}` to over-credit: only Ophis-recipient
 * entries are considered. This decoder returns the verified flat entry only.
 * CoW's `executedProtocolFees` reports intended policy amounts without a fee
 * recipient and is not proof that Ophis received the transfer, so improvement
 * revenue stays excluded until it can be reconciled against actual transfers
 * to the Ophis Safe. The PI cap is never treated as collected revenue.
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
        return Math.min(raw, HISTORICAL_OPHIS_FEE_MAX_BPS);
      }
    } else if (
      // EXACT backend Surplus arm { surplusBps, maxVolumeBps } or PriceImprovement
      // arm { priceImprovementBps, maxVolumeBps } (integers, mutually exclusive, no
      // volumeBps/bps). A VALID such fee is a real Ophis fee on a CoW-hosted chain
      // (CoW accepts CIP-75 Surplus/PI; only the OP sovereign backend rejects it),
      // but the volume-derived indexer can't compute it -> defer to NULL (the API
      // later supplies its order-creation policy marker). A MALFORMED shape (e.g. missing
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
  // No usable flat Volume fee. A seen surplus/PI Ophis fee -> NULL (policy-marker fallback,
  // still earns). Otherwise Ophis collected nothing -> 0 (credit zero).
  return sawOphisNonVolumeFee ? null : 0;
}

type AppDataFeeKind = 'volume' | 'surplus' | 'priceImprovement';

function appDataFeeKind(entry: unknown): AppDataFeeKind | null {
  const fee = entry as {
    volumeBps?: unknown;
    bps?: unknown;
    surplusBps?: unknown;
    priceImprovementBps?: unknown;
  };
  if (typeof fee?.volumeBps === 'number' || typeof fee?.bps === 'number') return 'volume';
  if (typeof fee?.surplusBps === 'number') return 'surplus';
  if (typeof fee?.priceImprovementBps === 'number') return 'priceImprovement';
  return null;
}

function executedFeeKind(policy: NonNullable<CowTrade['executedProtocolFees']>[number]['policy']): AppDataFeeKind {
  if ('volume' in policy) return 'volume';
  if ('surplus' in policy) return 'surplus';
  return 'priceImprovement';
}

function approxFactor(actual: number, bps: number): boolean {
  return Math.abs(actual - bps / 10_000) <= 1e-10;
}

function appDataMatchesExecutedFee(
  entry: unknown,
  policy: NonNullable<CowTrade['executedProtocolFees']>[number]['policy'],
): boolean {
  const fee = entry as {
    volumeBps?: unknown;
    bps?: unknown;
    surplusBps?: unknown;
    priceImprovementBps?: unknown;
    maxVolumeBps?: unknown;
  };
  const volumeBps = typeof fee.volumeBps === 'number' ? fee.volumeBps : fee.bps;
  if ('volume' in policy) return typeof volumeBps === 'number' && approxFactor(policy.volume.factor, volumeBps);
  if ('surplus' in policy) {
    return typeof fee.surplusBps === 'number' && typeof fee.maxVolumeBps === 'number'
      && approxFactor(policy.surplus.factor, fee.surplusBps)
      && approxFactor(policy.surplus.maxVolumeFactor, fee.maxVolumeBps);
  }
  return typeof fee.priceImprovementBps === 'number' && typeof fee.maxVolumeBps === 'number'
    && approxFactor(policy.priceImprovement.factor, fee.priceImprovementBps)
    && approxFactor(policy.priceImprovement.maxVolumeFactor, fee.maxVolumeBps);
}

function isCanonicalOphisImprovement(
  policy: NonNullable<CowTrade['executedProtocolFees']>[number]['policy'],
): boolean {
  if (!('priceImprovement' in policy)) return false;
  const fee = policy.priceImprovement;
  return (approxFactor(fee.factor, 8_000) && approxFactor(fee.maxVolumeFactor, 99))
    || (approxFactor(fee.factor, 5_000) && approxFactor(fee.maxVolumeFactor, 20));
}

/**
 * Per-fill Ophis fee rate for public reporting only. Backend fee policies are
 * applied as operator policies followed by appData partner fees, and the trades
 * API returns execution amounts in that same application order. Requiring the
 * complete appData suffix to match by policy kind lets us select only the slots
 * whose recipient is Ophis, even when another recipient uses identical factors.
 *
 * This is an assessed settlement-policy amount, not recipient-reconciled cash,
 * and therefore must never be copied into the affiliate-liability ledger.
 */
export function readAssessedOphisFeeBps(
  chainId: number,
  orderClass: 'market' | 'limit' | 'liquidity' | undefined,
  meta: unknown,
  trade: CowTrade,
): string | null {
  const raw = (meta as { metadata?: { partnerFee?: unknown } })?.metadata?.partnerFee;
  const appFees = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<{ recipient?: unknown }>;
  const executed = trade.executedProtocolFees ?? [];
  if (appFees.length === 0 || executed.length < appFees.length) return null;

  // Operated market orders prepend one canonical Ophis improvement policy;
  // limit orders have only the appData policies. Exact cardinality plus the
  // value-level suffix match below rejects layouts where a recipient was filtered.
  const sovereign = SOVEREIGN_CHAIN_IDS.has(chainId);
  let hasSovereignImprovement = false;
  if (sovereign) {
    if (orderClass === 'market'
      && executed.length === appFees.length + 1
      && isCanonicalOphisImprovement(executed[0]!.policy)) {
      hasSovereignImprovement = true;
    } else if ((orderClass !== 'limit' && orderClass !== 'liquidity')
      || executed.length !== appFees.length) {
      return null;
    }
  }

  const offset = executed.length - appFees.length;
  for (let i = 0; i < appFees.length; i += 1) {
    const expected = appDataFeeKind(appFees[i]);
    if (expected === null
      || executedFeeKind(executed[offset + i]!.policy) !== expected
      || !appDataMatchesExecutedFee(appFees[i], executed[offset + i]!.policy)) return null;
  }

  const ophisFees = appFees.flatMap((entry, i) =>
    typeof entry.recipient === 'string' && entry.recipient.toLowerCase() === OPHIS_FEE_RECIPIENT
      ? [executed[offset + i]!]
      : [],
  );
  if (hasSovereignImprovement) ophisFees.unshift(executed[0]!);
  if (ophisFees.length === 0) return null;
  const token = ophisFees[0]!.token.toLowerCase();
  if (ophisFees.some((fee) => fee.token.toLowerCase() !== token)) return null;

  const assessed = ophisFees.reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  const allFeesInToken = executed
    .filter((fee) => fee.token.toLowerCase() === token)
    .reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  let grossVolume: bigint;
  if (token === trade.buyToken.toLowerCase()) {
    grossVolume = BigInt(trade.buyAmount) + allFeesInToken;
  } else if (token === trade.sellToken.toLowerCase()) {
    // The trades API defines sellAmountBeforeFees as the fee-free executed sell
    // amount (database derivation: sell_amount - fee_amount). Do not deduct the
    // executed protocol fees a second time.
    grossVolume = BigInt(trade.sellAmountBeforeFees ?? trade.sellAmount);
  } else {
    return null;
  }
  if (grossVolume <= 0n) return null;

  const scale = 100_000_000n;
  const scaledBps = (assessed * 10_000n * scale + grossVolume / 2n) / grossVolume;
  // Sequential 99 bp improvement + 1 bp base can compound to 100.0099 bps.
  if (scaledBps > 10_001_000_000n) return null;
  return `${scaledBps / scale}.${(scaledBps % scale).toString().padStart(8, '0')}`;
}

/** A verified appData zero is exact on hosted chains. Sovereign backends can
 * prepend Ophis price improvement independently, so their zero stays pending. */
export function verifiedHostedZeroAssessment(
  chainId: number,
  verifiedVolumeFeeBps: number | null,
): string | null {
  return verifiedVolumeFeeBps === 0 && !SOVEREIGN_CHAIN_IDS.has(chainId) ? '0.00000000' : null;
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
 * The shared canonical eth-flow on CoW-hosted
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
  // Robinhood (4663): Ophis-deployed eth-flow, live from block 21,574,754.
  4663: '0xc1ee77e8a1b85d5eed702a9bb435f434408a4d29',
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
  let basketId: string | null = null;
  let volumeFeeBps: number | null = null;
  let ownFee: { bps: number; recipient: `0x${string}` } | null = null;
  try {
    const m = meta as {
      appCode?: unknown;
      metadata?: {
        widget?: { appCode?: unknown };
        ophisReferrer?: { code?: unknown };
        referrer?: { code?: unknown };
        ophisBasket?: { id?: unknown };
      };
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
    // FALLBACK: metadata.referrer.code — the schema-standard field the Ophis frontend
    // attaches to every order carrying a saved ?ref code (buildAppData.ts). Without it,
    // a wallet whose signed bind never landed (rejected popup, clock skew) traded with
    // the code inert forever (audit 2026-07-09). Same grammar + fee gates apply, and
    // the accrual layer keeps its active-code / non-self / appData-wins guards.
    const rawRef = m?.metadata?.ophisReferrer?.code ?? m?.metadata?.referrer?.code;
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
    // Basket (multi-order) passthrough: metadata.ophisBasket.id groups the legs
    // of one basket. Pure analytics, NO fee gate (it earns no rebate), unlike
    // the referral code above. Grammar-validated to the 32-hex basket-id shape
    // (mirror of packages/sdk/src/basket-metadata.ts OPHIS_BASKET_ID_RE); a
    // malformed value is dropped to NULL rather than stored.
    const rawBasket = m?.metadata?.ophisBasket?.id;
    if (typeof rawBasket === 'string' && /^[0-9a-f]{32}$/.test(rawBasket)) {
      basketId = rawBasket;
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
    basketId,
    volumeFeeBps,
    undecodedFeeFallbackBps: null,
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
      // The rebate ledger collapses an order's fills into one total, while the
      // DefiLlama ledger preserves every fill. `firstForOrder` controls only the
      // former; never skip a later API trade row before reporting it.
      const firstForOrder = !seen.has(t.orderUid);
      if (firstForOrder) seen.add(t.orderUid);

      // Skip if already in DB — cheap key lookup. Skipped when db not provided (e.g. unit tests).
      let rebateRowComplete = false;
      if (deps.db) {
        // Lazily import sql + schema only when we have a real db instance.
        const { sql, schema } = await import('./db/index.js');
        const already = await deps.db
          .select({
            uid: schema.trades.tradeUid,
            volumeFeeBps: schema.trades.volumeFeeBps,
            undecodedFeeFallbackBps: schema.trades.undecodedFeeFallbackBps,
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
        const row = already[0] as {
          volumeFeeBps: number | null;
          undecodedFeeFallbackBps: number | null;
          feeVerified: boolean;
        } | undefined;
        rebateRowComplete = Boolean(
          row && row.feeVerified &&
          (row.volumeFeeBps !== null || row.undecodedFeeFallbackBps !== null),
        );
      }
      const fillKey = {
        chainId,
        blockNumber: BigInt(t.blockNumber),
        logIndex: t.logIndex,
        tradeUid: t.orderUid as `0x${string}`,
      };
      const fillSink = DEFILLAMA_CHAIN_IDS.has(chainId) ? deps.defillamaFills : undefined;
      const reportFillComplete = fillSink
        ? await deps.hasDefiLlamaFill?.(fillKey) ?? false
        : true;
      if ((!firstForOrder || rebateRowComplete) && reportFillComplete) continue;

      // Confirm appCode by fetching the order. We could store unfiltered trades and filter
      // at scoring time, but fetching the order resolves fullAppData (avoids storing trades
      // that turn out to be unrelated to Ophis) and gives us the settlement creationDate.
      const order = await getOrder(chainId, t.orderUid as `0x${string}`);

      // The aggregate rebate row is terminal-only because it stores one lifetime
      // order total. The reporting fill below is independent and is recorded as soon
      // as its settled API trade appears, including while a partial order remains open.
      const isTerminal =
        order.status === 'fulfilled' || order.status === 'cancelled' || order.status === 'expired';
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
      if (isTerminal && firstForOrder && !rebateRowComplete) {
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
        if (trade) {
          const createdAt = new Date(order.creationDate);
          trade.volumeFeeBps = affiliateFeeBpsForOrderCreatedAt(trade.volumeFeeBps, createdAt);
          trade.undecodedFeeFallbackBps = undecodedFeeFallbackBpsForOrderCreatedAt(
            createdAt,
          );
          out.push(trade);
        }
      }

      if (fillSink && !reportFillComplete) {
        const settlementTimestamp = await (deps.getSettlementTimestamp ?? getSettlementTimestamp)(
          chainId,
          BigInt(t.blockNumber),
        );
        const fill = attributeOrder(meta, {
          owner: t.owner,
          receiver: order.receiver,
          sellToken: t.sellToken as `0x${string}`,
          buyToken: t.buyToken as `0x${string}`,
          executedSell: BigInt(t.sellAmount),
          executedBuy: BigInt(t.buyAmount),
          tradeUid: t.orderUid as `0x${string}`,
          chainId,
          blockNumber: BigInt(t.blockNumber),
          blockTimestamp: settlementTimestamp,
        });
        if (fill) {
          const createdAt = new Date(order.creationDate);
          fill.volumeFeeBps = affiliateFeeBpsForOrderCreatedAt(fill.volumeFeeBps, createdAt);
          const assessedFeeBps = readAssessedOphisFeeBps(chainId, order.class, meta, t)
            ?? verifiedHostedZeroAssessment(chainId, fill.volumeFeeBps);
          fillSink.push({
            ...fillKey,
            transactionHash: t.txHash as `0x${string}`,
            userAddress: fill.wallet,
            settlementTimestamp,
            sellToken: fill.sellToken,
            sellAmount: fill.sellAmount,
            buyToken: fill.buyToken,
            buyAmount: fill.buyAmount,
            volumeFeeBps: fill.volumeFeeBps,
            assessedFeeBps,
            feeVerified: true,
          });
        }
      }
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
// How long a `wait: true` caller queues behind an active holder before giving up.
// Sized to outlive a trade-rewards run (the 5-minutely competitor for this lock)
// while still bounding the wait so a wedged holder cannot hang the caller.
// Bound on a `wait: true` acquisition. Derived from the WORST-CASE runtime of the
// competing holder, not guessed: submitPendingAssignments (tradeRewards/service.ts)
// processes up to 10 rows sequentially and each relayAssignment awaits
// waitForTransactionReceipt with NO explicit timeout, so viem's 180s default
// applies per row => ~30 min of legitimate, non-wedged work. A bound below that
// would skip the nightly refresh while the holder was healthy and still
// progressing. 40 min leaves headroom for the per-row signing/state reads.
// If either input changes (the LIMIT 10, or an explicit receipt timeout), revisit.
const PIPELINE_LOCK_WAIT_MS = 40 * 60 * 1_000;
// Held by a `wait: true` caller for its ENTIRE wait+run. Non-waiting callers
// check it and defer, which is what actually gives the nightly run priority: a
// polling waiter is NOT a registered Postgres lock waiter during its sleep, so
// without this gate a 5-minutely reward tick could repeatedly win the lock in the
// gap between the holder releasing and the next poll, starving the nightly run
// for its whole window even though no individual holder was wedged.
const NIGHTLY_PENDING_LOCK_KEY = 770045;
const PIPELINE_LOCK_RETRY_MS = 5_000;

/**
 * Run `fn` while holding a PIPELINE-level advisory lock so the two pipeline
 * triggers — the non-blocking startup backfill and the nightly cron — can never
 * overlap. Without this they can race on price/score, and on the 1st the cron's
 * batcher could propose a Safe payout off a matview a concurrent backfill is
 * mid-updating. The default is a non-blocking attempt for optional startup and
 * reward work. The once-daily nightly pipeline passes `wait: true`, so it queues
 * instead of losing its only invocation to a short reward tick. Distinct key
 * from the fetcher lock, so nested runFetcher calls still work.
 */
export async function withPipelineLock(
  fn: () => Promise<void>,
  options: { wait?: boolean } = {},
): Promise<boolean> {
  const { sql } = await import('./db/index.js');
  const lockConn = await sql.reserve();
  let locked = false;
  let pending = false;
  try {
    if (options.wait) {
      // Announce the pending nightly run BEFORE queueing for the pipeline lock,
      // and hold it for the whole wait+run. Non-waiting callers defer on it, so
      // reward ticks stop competing the moment a nightly run starts waiting.
      // Without this the poll loop below can be starved: it is not a registered
      // Postgres lock waiter while it sleeps, so a try-locking reward tick can
      // slip in during the gap after a holder releases.
      const [p] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${NIGHTLY_PENDING_LOCK_KEY}) AS locked`;
      pending = p?.locked === true;
      if (!pending) {
        // Another nightly run is already pending/active. Two concurrent nightly
        // runs is exactly what the pipeline lock exists to prevent, so decline
        // rather than queue a second waiter.
        log.error('another nightly pipeline run is already pending; skipping');
        return false;
      }
    }
    if (!options.wait) {
      // Defer to a pending nightly run. It only gets ONE invocation a day; this
      // caller (reward tick, startup backfill, CLI) will run again shortly.
      const [p] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${NIGHTLY_PENDING_LOCK_KEY}) AS locked`;
      if (p?.locked !== true) {
        log.info('a nightly pipeline run is pending; deferring');
        return false;
      }
      // We only probed. Release immediately — holding it would block the nightly.
      await lockConn`SELECT pg_advisory_unlock(${NIGHTLY_PENDING_LOCK_KEY})`;
    }
    if (options.wait) {
      // BOUNDED wait, not pg_advisory_lock(). A plain blocking acquire waits
      // forever: an advisory lock is held for as long as its session lives, so a
      // reward run wedged on an RPC call with no timeout would pin this reserved
      // connection indefinitely and the nightly pipeline would never run OR
      // report. That converts a visible, recoverable skip into a silent hang on
      // a money path (the 1st-of-month Safe proposal). Poll instead and give the
      // caller back a `false` it can alert on.
      log.info('waiting for exclusive pipeline lock');
      const deadline = Date.now() + PIPELINE_LOCK_WAIT_MS;
      for (;;) {
        const [row] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${PIPELINE_LOCK_KEY}) AS locked`;
        locked = row?.locked === true;
        if (locked) break;
        if (Date.now() >= deadline) {
          log.error({ waitedMs: PIPELINE_LOCK_WAIT_MS }, 'gave up waiting for the pipeline lock');
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, PIPELINE_LOCK_RETRY_MS));
      }
    } else {
      const [row] = await lockConn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${PIPELINE_LOCK_KEY}) AS locked`;
      locked = row?.locked === true;
      if (!locked) {
        log.info('another pipeline run holds the lock; skipping');
        return false;
      }
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
    if (pending) {
      try {
        await lockConn`SELECT pg_advisory_unlock(${NIGHTLY_PENDING_LOCK_KEY})`;
      } catch (err) {
        // Not fatal: the lock is session-scoped and dies with this reserved
        // connection. Logged because until then every non-waiting caller defers.
        log.error({ err }, 'nightly-pending advisory unlock failed');
      }
    }
    lockConn.release();
  }
}

export interface RunFetcherOptions {
  /**
   * ABSOLUTE cutoff: re-fetch a tracked wallet whose last_fetched precedes this
   * instant. Defaults to now minus 6 hours -- the historical behaviour, right for
   * the 02:00 nightly.
   *
   * ABSOLUTE, not a relative window, and this matters. Comparing
   * `last_fetched < now() - interval` fetches each wallet only every OTHER tick
   * on an hourly cadence: a wallet fetched at 12:05 is not "older than one hour"
   * when the 13:00 tick asks, yet that tick records 13:00 as serviced and no
   * later poll retries inside it, so the wallet waits until ~14:00. A fetch at
   * exactly 12:00 also fails a strict `< 12:00`. Passing the BOUNDARY makes
   * anything not fetched since it opened eligible, once per boundary.
   */
  staleBefore?: Date;
  /**
   * Wall-clock epoch ms after which the owner loop stops starting new work.
   *
   * The quiet window bounds when a refresh may START; it bounds nothing about
   * how long one RUNS. With ~29 tracked wallets and 14 sequential chain requests
   * each, an orderbook outage reaching the existing 10s request timeout is
   * roughly 68 minutes -- past the 60-minute window and into the nightly, whose
   * bounded lock wait then expires and delays the monthly payout path.
   *
   * Checked BETWEEN OWNERS, which is cooperative and safe (no half-written
   * owner) and bounds the run to this deadline plus one owner's worst case,
   * about 140 seconds.
   */
  deadlineMs?: number;
}

const DEFAULT_FETCH_STALE_AFTER_MS = 6 * 60 * 60 * 1_000;

export async function runFetcher(
  _deps?: FetcherDeps,
  opts: RunFetcherOptions = {},
): Promise<{ inserted: number; owners: number }> {
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

    const pendingDefillamaFills: PendingDefiLlamaFill[] = [];
    const dbDeps: FetcherDeps = {
      db: db as unknown as FetcherDb,
      defillamaFills: pendingDefillamaFills,
      hasDefiLlamaFill: async (fill) => {
        // Complete = VERIFIED. A decoder DISCOVERY fill (fee_verified=false) must
        // not satisfy this check: the API path is the only source that can serve
        // the authoritative fee, and treating the provisional row as complete
        // would skip the re-process that upgrades it (computeDefiLlamaDay counts
        // verified fills only, so an un-upgradeable row is permanently omitted).
        const [row] = await sql<{ present: boolean }[]>`
          SELECT EXISTS(
            SELECT 1 FROM defillama_fills
            WHERE chain_id = ${fill.chainId}
              AND block_number = ${fill.blockNumber.toString()}
              AND log_index = ${fill.logIndex}
              AND trade_uid = decode(${fill.tradeUid.slice(2)}, 'hex')
              AND fee_verified = true
              AND assessed_fee_bps IS NOT NULL
              AND transaction_hash IS NOT NULL
              AND user_address IS NOT NULL
          ) AS present
        `;
        return row?.present === true;
      },
      getSettlementTimestamp,
    };

    // Bounded, round-robin owner set. `/tier` is public, so tracked_wallets can
    // be spammed with arbitrary addresses; without a cap, runFetcher would do
    // (rows × 12 chains) CoW calls and amplify that into a self-DoS + CoW
    // rate-limit exhaustion. We process at most MAX_OWNERS_PER_RUN per tick,
    // proven wallets (those that already produced an Ophis trade) FIRST so spam
    // can never starve them, then oldest-fetched. Junk is evicted below.
    // Lower clamp only. The upper bound is `now`: the nightly deliberately passes
    // `now` for a boundary-complete fetch, and shaving even a minute off would
    // exclude a wallet a startup backfill touched just before 02:00 -- exactly the
    // trade that must not be missing when the first-of-month batcher computes an
    // irreversible payout.
    const nowMs = Date.now();
    const requested = (opts.staleBefore ?? new Date(nowMs - DEFAULT_FETCH_STALE_AFTER_MS)).getTime();
    const staleBeforeIso = new Date(Math.min(Math.max(requested, nowMs - 86_400_000), nowMs)).toISOString();
    const ownerRows = await sql<{ wallet: string }[]>`
      SELECT '0x' || encode(wallet, 'hex') AS wallet
      FROM tracked_wallets
      WHERE last_fetched IS NULL
         OR last_fetched < ${staleBeforeIso}::timestamptz
         OR wallet IN (SELECT wallet FROM defillama_backfill_wallets)
      -- proven wallets first; then least-recently-fetched (never-fetched first);
      -- then OLDEST registration. The first_seen tiebreaker makes never-fetched
      -- selection FIFO so /tier spam can't starve an older legit wallet that
      -- registered before the flood (they'd otherwise tie on last_fetched=NULL).
      ORDER BY (wallet IN (SELECT wallet FROM defillama_backfill_wallets)) DESC,
               (wallet IN (SELECT wallet FROM trades)) DESC,
               last_fetched ASC NULLS FIRST,
               first_seen ASC
      LIMIT ${FETCHER_MAX_OWNERS_PER_RUN}
    `;
    // Drop EVERY eth-flow contract enrolled as a tracked wallet (the /tier
    // endpoint now rejects them, but historical enrollments may persist):
    //   - Ophis-dedicated routers are fetched separately as synthetic owners
    //     below (attributing trades to the receiver, not themselves), so
    //     processing one here would double-fetch chain 10 and inflate the
    //     `inserted` log count.
    //   - The SHARED canonical CoW routers must never be fetched as an owner at
    //     all: an owner-scoped fetch of the shared contract lists all of CoW's
    //     eth-flow traffic, and attributeOrder's API path (narrow Ophis set)
    //     then stores Ophis orders with wallet = the router, the mis-attribution
    //     repaired by repair/routerTrades.ts. Their native-ETH orders attribute
    //     correctly via the on-chain settle() decoder (full DECODER set).
    const owners = ownerRows.filter((o) => !DECODER_ETHFLOW_OWNERS.has(o.wallet.toLowerCase()));
    let inserted = 0;
    let processedOwners = 0;
    // Reusable ON CONFLICT predicates (see the onConflictDoUpdate comment below).
    // FEE arms: only a verified API write moves volume_fee_bps / fee_verified;
    // the final arm also repairs post-cutover rows previously persisted above 1 bp.
    const FEE_UPGRADE_ARMS = dsql`(${schema.trades.volumeFeeBps} IS NULL AND excluded.volume_fee_bps > 0)
                                  OR (${schema.trades.feeVerified} = false AND excluded.fee_verified = true)
                                  OR (${schema.trades.volumeFeeBps} > 1
                                      AND excluded.undecoded_fee_fallback_bps = 1
                                      AND excluded.fee_verified = true)`;
    // OWN-FEE fill arm (finding #4): a still-NULL own_fee_bps on an existing row + a
    // non-null own_fee_bps from a VERIFIED incoming row. Verified-only so a decoder
    // discovery row (fee_verified=false) can never fill it. Reaches surplus/PI Ophis-fee
    // rows (volume_fee_bps NULL) that the fee arms structurally miss.
    const OWN_FEE_FILL_ARM = dsql`${schema.trades.ownFeeBps} IS NULL
                                  AND excluded.own_fee_bps IS NOT NULL
                                  AND excluded.fee_verified = true`;
    const POLICY_MARKER_FILL_ARM = dsql`${schema.trades.undecodedFeeFallbackBps} IS NULL
                                        AND excluded.undecoded_fee_fallback_bps IS NOT NULL
                                        AND excluded.fee_verified = true`;
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
            // basket_id is written on INSERT only (first-index-wins), NOT in the
            // on-conflict set below, mirroring appdata_ref_code's immutability.
            basketId: r.basketId,
            volumeFeeBps: r.volumeFeeBps,
            undecodedFeeFallbackBps: r.undecodedFeeFallbackBps,
            feeVerified: r.feeVerified,
            ownFeeBps: r.ownFeeBps,
            ownFeeRecipient: r.ownFeeRecipient,
            // A freshly-indexed row has ALREADY been through the own-fee decode
            // (attributeOrder ran readOwnFee), so stamp it scanned at insert time. This
            // keeps it OUT of the backfillOwnFee queue (which selects own_fee_scanned_at
            // IS NULL); the backfill only ever needs to reach pre-0016 rows.
            ownFeeScannedAt: new Date(),
          })),
        )
        // UPGRADE-only backfill on a re-encountered row, via four disjoint arms (a
        // VERIFIED API write is the only thing that ever updates an existing row; never a
        // downgrade, never a decoder clobber). Each column is set with a CASE so an arm
        // only touches the columns it owns:
        //  (1) FEE self-heal: a still-NULL pre-per-trade row -> a POSITIVE rate. The `> 0`
        //      is load-bearing: a historical NULL whose appData yields 0/NULL must STAY
        //      NULL (unknown), so re-fetching history can't reclassify it.
        //  (2) FEE decoder-upgrade: replace a settle() decoder DISCOVERY row
        //      (fee_verified=false, provisional 0) with the API's owner-allowlist-confirmed
        //      fee + fee_verified=true, at whatever rate (0 or > 0).
        //  (3) OWN-FEE fill (finding #4): an existing own_fee_bps IS NULL row whose
        //      incoming VERIFIED API appData decodes a non-null own_fee_bps. This covers a
        //      row the fee arms miss, e.g. a surplus/PI Ophis fee row (volume_fee_bps
        //      stays NULL) that stacked an integrator own-fee. It updates ONLY the own-fee
        //      columns and NEVER volume_fee_bps / fee_verified.
        //  (4) POLICY marker fill: persist the API-derived creation-time fallback
        //      without rewriting the decoder's settlement timestamp.
        // A decoder upsert carries excluded.fee_verified=false, so it satisfies NO arm ->
        // it can only INSERT a brand-new row and never overwrites an existing one.
        // volume_fee_bps / fee_verified move ONLY on the FEE arms (1|2); own_fee_bps /
        // own_fee_recipient / own_fee_scanned_at move on ANY arm (1|2|3). Everything else
        // (value_usd / priced_at / amounts) stays as first indexed. A plain re-fetch of an
        // already-verified, already-own-fee'd row matches no arm, so a stable row is left
        // untouched (its own-fee is not rewritten).
        .onConflictDoUpdate({
          target: schema.trades.tradeUid,
          set: {
            volumeFeeBps: dsql`CASE WHEN (${FEE_UPGRADE_ARMS}) THEN excluded.volume_fee_bps ELSE ${schema.trades.volumeFeeBps} END`,
            feeVerified: dsql`CASE WHEN (${FEE_UPGRADE_ARMS}) THEN excluded.fee_verified ELSE ${schema.trades.feeVerified} END`,
            undecodedFeeFallbackBps: dsql`CASE WHEN (${POLICY_MARKER_FILL_ARM}) THEN excluded.undecoded_fee_fallback_bps ELSE ${schema.trades.undecodedFeeFallbackBps} END`,
            ownFeeBps: dsql`CASE WHEN (${FEE_UPGRADE_ARMS}) OR (${OWN_FEE_FILL_ARM}) THEN excluded.own_fee_bps ELSE ${schema.trades.ownFeeBps} END`,
            ownFeeRecipient: dsql`CASE WHEN (${FEE_UPGRADE_ARMS}) OR (${OWN_FEE_FILL_ARM}) THEN excluded.own_fee_recipient ELSE ${schema.trades.ownFeeRecipient} END`,
            ownFeeScannedAt: dsql`CASE WHEN (${FEE_UPGRADE_ARMS}) OR (${OWN_FEE_FILL_ARM}) THEN excluded.own_fee_scanned_at ELSE ${schema.trades.ownFeeScannedAt} END`,
          },
          setWhere: dsql`(${FEE_UPGRADE_ARMS}) OR (${OWN_FEE_FILL_ARM}) OR (${POLICY_MARKER_FILL_ARM})`,
        });
      return rows.length;
    };
    const flushDefillamaFills = async (): Promise<void> => {
      if (pendingDefillamaFills.length === 0) return;
      await upsertDefillamaFills(pendingDefillamaFills.splice(0));
    };
    for (const { wallet } of owners) {
      if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
        log.warn({ processed: processedOwners, of: owners.length },
          'fetcher stopped at its deadline so the refresh cannot cross the nightly boundary');
        break;
      }
      processedOwners++;
      const owner = wallet as `0x${string}`;
      let ownerOk = true;
      let reportingOk = true;
      for (const chainId of SUPPORTED_CHAIN_IDS) {
        try {
          const rows = await fetchChainTrades(chainId, owner, dbDeps);
          inserted += await upsertTrades(rows);
          await flushDefillamaFills();
        } catch (err) {
          ownerOk = false; // a transient CoW failure must not silently advance the cursor
          if (DEFILLAMA_CHAIN_IDS.has(chainId)) reportingOk = false;
          log.error({ err, chainId, owner }, 'owner/chain fetch failed'); // single failure does not abort others
        }
      }
      // The one-time reporting queue tracks production chains only. A Sepolia
      // orderbook outage must not hold the public mainnet history closed forever.
      // Conversely, any production-chain failure keeps this wallet queued for retry.
      if (reportingOk) {
        await sql`DELETE FROM defillama_backfill_wallets WHERE wallet = decode(${owner.slice(2)}, 'hex')`;
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
        await flushDefillamaFills();
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
          // Settlement-fill persistence for decoder-discovered trades: the only
          // source of hosted-chain native-ETH (shared eth-flow) fills now that
          // routers are never fetched as owners. Fee fields carry the decoder's
          // gated values (DISCOVERY mode: fee 0 / unverified), so these fills are
          // excluded from /defillama until fee verification lands (ToB B1); the
          // per-fill event data is preserved for that upgrade.
          appendDefillamaFills: async (fills) => {
            pendingDefillamaFills.push(...fills.filter((f) => DEFILLAMA_CHAIN_IDS.has(f.chainId)));
            await flushDefillamaFills();
          },
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
          AND wallet NOT IN (SELECT wallet FROM defillama_backfill_wallets)
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
 * onto rows indexed BEFORE the own_fee_scanned_at marker (migration 0016). The hot
 * fetch loop SKIPS an already-verified row and the upsert enriches only NULL-fee /
 * unverified rows, so a VERIFIED pre-0014 trade never got own_fee_bps / own_fee_recipient
 * and GET /earnings/:appCode under-reports its historical own-fee. This re-resolves each
 * such row's settled appData ONCE and writes ONLY the own-fee columns via a TARGETED
 * UPDATE (never volume_fee_bps / fee_verified), so the verified Ophis fee and its
 * idempotence are untouched. The write re-checks own_fee_bps IS NULL so a concurrent
 * write is never clobbered.
 *
 * CONVERGENCE (why own_fee_scanned_at, not own_fee_bps IS NULL, is the queue state):
 * own_fee_bps IS NULL is OVERLOADED: the normal insert path writes NULL own_fee_bps for
 * every trade with no integrator own-fee (the vast majority). Keying the queue on it
 * re-selected the SAME oldest no-own-fee rows every run, wrote nothing, returned
 * updated:0 FOREVER, and could starve real-own-fee rows past the LIMIT window. Instead we
 * select own_fee_scanned_at IS NULL and ALWAYS stamp own_fee_scanned_at on a scan (found
 * an own-fee or not), so each row is scanned AT MOST ONCE and the queue drains. Dropping
 * the old volume_fee_bps IS NOT NULL filter also covers a surplus/PI Ophis-fee row
 * (volume_fee_bps NULL) that stacked an own-fee (finding #4).
 *
 * Run OUT of band (the backfill-own-fee CLI command), never inside runFetcher: it
 * re-fetches one order per scanned row, so it is not a per-run CoW load. Bounded by
 * `limit`; the pre-0016 backlog is finite and each bounded run permanently drains up to
 * `limit` of it.
 */
export async function backfillOwnFee(
  limit = 500,
  deps: BackfillDeps = {},
): Promise<{ scanned: number; updated: number }> {
  const { sql } = await import('./db/index.js');
  const fetchOrder = deps.getOrder ?? getOrder;
  const markScanned = (uidHex: string) =>
    sql`UPDATE trades SET own_fee_scanned_at = now() WHERE trade_uid = decode(${uidHex}, 'hex')`;
  // Verified rows never yet scanned for an own-fee. The marker (not own_fee_bps) is the
  // work-queue state, so a no-own-fee row is scanned once and then leaves the set. No
  // volume_fee_bps filter, so surplus/PI rows (volume_fee_bps NULL) are covered too.
  const rows = await sql<{ uid_hex: string; chain_id: number }[]>`
    SELECT encode(trade_uid, 'hex') AS uid_hex, chain_id
    FROM trades
    WHERE own_fee_scanned_at IS NULL
      AND fee_verified = true
    ORDER BY fetched_at ASC
    LIMIT ${limit}
  `;
  let scanned = 0;
  let updated = 0;
  for (const r of rows) {
    scanned++;
    if (!SUPPORTED_CHAIN_IDS.includes(r.chain_id)) {
      // Not a chain we can re-fetch; it can never gain an own-fee here, so mark it
      // scanned so it leaves the queue and the backfill still converges.
      await markScanned(r.uid_hex);
      continue;
    }
    const uid = `0x${r.uid_hex}` as `0x${string}`;
    let order: { fullAppData?: string | null };
    try {
      order = await fetchOrder(r.chain_id, uid);
    } catch (err) {
      // TRANSIENT: do NOT mark scanned; leave it in the queue to retry next run so a
      // CoW blip can't permanently skip a row that might carry an own-fee.
      log.warn({ err, chainId: r.chain_id, uid }, 'backfill-own-fee: getOrder failed; leaving unscanned to retry');
      continue;
    }
    // Only a SUCCESSFULLY-PARSED real appData document is conclusive. A missing or
    // malformed fullAppData is treated like the transient getOrder miss above:
    // leave the row UNSCANNED so a later read that resolves the appData can still
    // reveal a stacked own-fee. Stamping here would permanently drop the row on a
    // transient app-data resolver miss and underreport historical own-fee.
    if (!order.fullAppData) {
      log.warn({ chainId: r.chain_id, uid }, 'backfill-own-fee: order has no fullAppData; leaving unscanned to retry');
      continue;
    }
    let meta: unknown;
    try {
      meta = JSON.parse(order.fullAppData);
    } catch {
      log.warn({ chainId: r.chain_id, uid }, 'backfill-own-fee: malformed fullAppData; leaving unscanned to retry');
      continue;
    }
    const own = readOwnFee(meta);
    // ALWAYS stamp own_fee_scanned_at so the row leaves the candidate set; write
    // own_fee_bps / own_fee_recipient ONLY when an own-fee is actually decoded. The
    // own_fee_bps IS NULL guard keeps a concurrent write from being clobbered.
    if (own) {
      const res = await sql`
        UPDATE trades
        SET own_fee_bps = ${own.bps},
            own_fee_recipient = decode(${own.recipient.slice(2)}, 'hex'),
            own_fee_scanned_at = now()
        WHERE trade_uid = decode(${r.uid_hex}, 'hex') AND own_fee_bps IS NULL
      `;
      updated += res.count ?? 0;
    } else {
      await markScanned(r.uid_hex);
    }
  }
  log.info({ scanned, updated }, 'backfill-own-fee complete');
  return { scanned, updated };
}
