import { sql } from '../db/index.js';
import { getRpcClient } from '../rpc/client.js';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeFunctionData } from 'viem';
import { SETTLE_FN, TRADE_EVENT, settlementAddressFor } from '../cow/settleAbi.js';
import { getOrder, listTrades } from '../cow/client.js';
import { resolveAppData } from '../cow/appDataResolver.js';
import { advertisedLogRangeLimit, isRangeError } from '../cow/onchain.js';
import {
  attributeOrder,
  DECODER_ETHFLOW_OWNERS,
  readAssessedOphisFeeBps,
  upsertDefillamaFills,
  verifiedHostedZeroAssessment,
  type PendingDefiLlamaFill,
} from '../fetcher.js';
import { affiliateFeeBpsForOrderCreatedAt } from '../affiliate/rates.js';
import { logger } from '../logger.js';
import { PRODUCTION_CHAIN_IDS } from '../stats-page.js';
import { OPHIS_SAFE_ADDRESS } from '../safe/addresses.js';
import type { CowTrade } from '../cow/types.js';

const log = logger.child({ module: 'repair-defillama-settlement' });
const REPAIR_LIMIT = 500;
const API_PAGE_SIZE = 1_000;
const MAX_API_PAGES = 100;
// Completeness scans filter one settlement address and a small UID set, so begin
// with a wide archive window and halve on provider limits. Starting at the
// decoder's 2,000-block discovery window would require thousands of RPC calls.
const ONCHAIN_SCAN_WINDOW = 50_000n;
const ONCHAIN_SCAN_DELAY_MS = 250;
const ONCHAIN_RATE_LIMIT_RETRIES = 5;
// The operated-chain improvement policy was deployed on 2026-08-11. Before this
// conservative boundary, a settlement with one Ophis flat appData policy has no
// separate operator policy and can be reproduced from immutable settlement data.
const LEGACY_FLAT_FEE_CUTOFF = new Date('2026-08-10T00:00:00.000Z');
// Historical sovereign backends used the autopilot's default max-partner-fee of
// 1%. Raw appData above this was capped before integer fee assessment.
const LEGACY_MAX_PARTNER_FEE_BPS = 100;
const ROUTER_WALLETS: readonly string[] = Object.freeze([...DECODER_ETHFLOW_OWNERS]);
const OPHIS_SAFE = OPHIS_SAFE_ADDRESS.toLowerCase();

interface TradeEventLog {
  args: {
    owner: `0x${string}`;
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    sellAmount: bigint;
    buyAmount: bigint;
    feeAmount: bigint;
    orderUid: `0x${string}`;
  };
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

interface SettlementSource {
  owner: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  feeAmount: bigint | null;
  side: 'sell' | 'buy' | null;
  appDataHash: `0x${string}` | null;
  receiver: `0x${string}` | null;
  tradeUid: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  apiTrade: CowTrade | null;
}

interface RepairResult {
  identities: number;
  fills: number;
  fees: number;
  failedBlocks: number;
}

interface BatchRepairResult extends RepairResult {
  audits: number;
}

interface OnchainScanResult {
  sources: Map<string, SettlementSource[]>;
  safeHead: bigint;
}

interface PreparedOnchainAudit {
  byChain: ReadonlyMap<number, OnchainScanResult | null>;
  failedScans: number;
}

async function blockTradeLogs(chainId: number, blockNumber: bigint): Promise<TradeEventLog[]> {
  return (await getRpcClient(chainId).getLogs({
    address: settlementAddressFor(chainId),
    event: TRADE_EVENT,
    fromBlock: blockNumber,
    toBlock: blockNumber,
  })) as unknown as TradeEventLog[];
}

/** Fetch every orderbook settlement for one UID. Exact-UID results are still
 * paginated: stopping after the first page would recreate the partial-fill gap. */
async function allTradesForUid(chainId: number, orderUid: `0x${string}`): Promise<CowTrade[]> {
  const bySettlement = new Map<string, CowTrade>();
  for (let pageNumber = 0; pageNumber < MAX_API_PAGES; pageNumber++) {
    const page = await listTrades({
      chainId,
      orderUid,
      offset: pageNumber * API_PAGE_SIZE,
      limit: API_PAGE_SIZE,
    });
    for (const trade of page) {
      if (trade.orderUid.toLowerCase() !== orderUid.toLowerCase()) {
        throw new Error(`exact-UID response returned a different order: ${trade.orderUid}`);
      }
      bySettlement.set(`${trade.blockNumber}:${trade.logIndex}`, trade);
    }
    if (page.length < API_PAGE_SIZE) return [...bySettlement.values()];
  }
  throw new Error(`exact-UID pagination exceeded ${MAX_API_PAGES} pages for ${orderUid}`);
}

function sourceFromApi(trade: CowTrade): SettlementSource {
  return {
    owner: trade.owner as `0x${string}`,
    sellToken: trade.sellToken as `0x${string}`,
    buyToken: trade.buyToken as `0x${string}`,
    sellAmount: BigInt(trade.sellAmount),
    buyAmount: BigInt(trade.buyAmount),
    feeAmount: null,
    side: null,
    appDataHash: null,
    receiver: null,
    tradeUid: trade.orderUid as `0x${string}`,
    transactionHash: trade.txHash as `0x${string}`,
    blockNumber: BigInt(trade.blockNumber),
    logIndex: trade.logIndex,
    apiTrade: trade,
  };
}

function sourceFromLog(
  event: TradeEventLog,
  decoded: Pick<SettlementSource, 'side' | 'appDataHash' | 'receiver'>,
): SettlementSource {
  return {
    owner: event.args.owner,
    sellToken: event.args.sellToken,
    buyToken: event.args.buyToken,
    sellAmount: event.args.sellAmount,
    buyAmount: event.args.buyAmount,
    feeAmount: event.args.feeAmount,
    ...decoded,
    tradeUid: event.args.orderUid,
    transactionHash: event.transactionHash,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    apiTrade: null,
  };
}

function isStrongRateLimitError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('requests per second') ||
    message.includes('too many requests') ||
    message.includes('429')
  );
}

function isRateLimitError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return isStrongRateLimitError(err) || message.includes('capacity');
}

/** Range signatures that are specific enough to outrank broad throttling words
 * such as "capacity". The generic "limit exceeded" signature is deliberately
 * omitted: "rate limit exceeded" must still back off without shrinking. */
function isExplicitRangeError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes('-32602') ||
    message.includes('-32614') ||
    message.includes('block range') ||
    message.includes('range too large') ||
    advertisedLogRangeLimit(err) !== null ||
    message.includes('10000 results') ||
    message.includes('query returned more than') ||
    message.includes('response size')
  );
}

/**
 * Sovereign orderbooks can be replaced or pruned while settlement logs remain
 * immutable. Scan the configured decoder history for every audited UID on that
 * chain, even when the API returns a non-empty subset: a partially filled order
 * can straddle an orderbook pruning boundary. The scan is shared across UIDs.
 */
async function onchainSourcesForUids(
  chainId: number,
  orderUids: readonly `0x${string}`[],
): Promise<OnchainScanResult> {
  const startRaw = process.env[`SETTLE_SCAN_START_BLOCK_${chainId}`];
  if (!startRaw) {
    throw new Error(`no SETTLE_SCAN_START_BLOCK_${chainId} for on-chain exact-UID fallback`);
  }
  const client = getRpcClient(chainId);
  const safeHead = (await client.getBlockNumber()) - 8n;
  let from = BigInt(startRaw);
  let window = ONCHAIN_SCAN_WINDOW;
  const wanted = new Set(orderUids.map((uid) => uid.toLowerCase()));
  const found = new Map<string, SettlementSource[]>();
  let requests = 0;
  let rateLimitRetries = 0;
  while (from <= safeHead) {
    const to = from + window - 1n > safeHead ? safeHead : from + window - 1n;
    let logs: TradeEventLog[];
    try {
      if (requests > 0) await delay(ONCHAIN_SCAN_DELAY_MS);
      logs = (await client.getLogs({
        address: settlementAddressFor(chainId),
        event: TRADE_EVENT,
        fromBlock: from,
        toBlock: to,
      })) as unknown as TradeEventLog[];
      requests++;
      rateLimitRetries = 0;
    } catch (err) {
      // Strong throttling markers (429, "rate limit") always back off. Otherwise,
      // concrete response-size/range errors outrank broad words such as "capacity".
      // The generic "limit exceeded" signature remains the final range fallback.
      if (isExplicitRangeError(err) && !isStrongRateLimitError(err)) {
        if (window > 1n) {
          const advertised = advertisedLogRangeLimit(err);
          window = advertised !== null && advertised < window ? advertised : window >> 1n;
          continue;
        }
        throw err;
      }
      if (isRateLimitError(err)) {
        if (rateLimitRetries < ONCHAIN_RATE_LIMIT_RETRIES) {
          rateLimitRetries++;
          await delay(500 * 2 ** (rateLimitRetries - 1));
          continue;
        }
        throw err;
      }
      if (isRangeError(err) && window > 1n) {
        const advertised = advertisedLogRangeLimit(err);
        window = advertised !== null && advertised < window ? advertised : window >> 1n;
        continue;
      }
      throw err;
    }
    const byTransaction = new Map<string, TradeEventLog[]>();
    for (const event of logs) {
      const txHash = event.transactionHash.toLowerCase();
      const rows = byTransaction.get(txHash) ?? [];
      rows.push(event);
      byTransaction.set(txHash, rows);
    }
    for (const [txHash, transactionLogs] of byTransaction) {
      if (!transactionLogs.some((event) => wanted.has(event.args.orderUid.toLowerCase()))) continue;
      transactionLogs.sort((a, b) => a.logIndex - b.logIndex);
      let decodedTrades: Array<Pick<SettlementSource, 'side' | 'appDataHash' | 'receiver'>> =
        transactionLogs.map(() => ({ side: null, appDataHash: null, receiver: null }));
      try {
        const transaction = await client.getTransaction({ hash: txHash as `0x${string}` });
        const decoded = decodeFunctionData({ abi: [SETTLE_FN], data: transaction.input });
        const args = decoded.args as unknown as readonly [
          readonly `0x${string}`[],
          readonly bigint[],
          readonly {
            sellTokenIndex: bigint;
            buyTokenIndex: bigint;
            flags: bigint;
            appData: `0x${string}`;
            receiver: `0x${string}`;
          }[],
          unknown,
        ];
        const tokens = args[0];
        const calldataTrades = args[2];
        if (calldataTrades.length !== transactionLogs.length) {
          throw new Error(
            `settle calldata has ${calldataTrades.length} trades for ${transactionLogs.length} Trade logs`,
          );
        }
        decodedTrades = calldataTrades.map((trade, index) => {
          const event = transactionLogs[index]!;
          const sellToken = tokens[Number(trade.sellTokenIndex)];
          const buyToken = tokens[Number(trade.buyTokenIndex)];
          if (
            sellToken?.toLowerCase() !== event.args.sellToken.toLowerCase() ||
            buyToken?.toLowerCase() !== event.args.buyToken.toLowerCase()
          ) {
            throw new Error(
              `settle calldata token indexes disagree at Trade log ${event.logIndex}`,
            );
          }
          return {
            side: (trade.flags & 1n) === 0n ? 'sell' : 'buy',
            appDataHash: trade.appData,
            receiver: trade.receiver,
          };
        });
      } catch (err) {
        // The settlement identity is still immutable and useful. Leave its side
        // unknown so legacy fees remain pending rather than guessing from policy.
        log.warn({ err, chainId, txHash }, 'settlement calldata decode failed');
      }
      for (let index = 0; index < transactionLogs.length; index++) {
        const event = transactionLogs[index]!;
        const uid = event.args.orderUid.toLowerCase();
        if (!wanted.has(uid)) continue;
        const rows = found.get(uid) ?? [];
        rows.push(
          sourceFromLog(
            event,
            decodedTrades[index] ?? { side: null, appDataHash: null, receiver: null },
          ),
        );
        found.set(uid, rows);
      }
    }
    from = to + 1n;
  }
  for (const rows of found.values()) {
    rows.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );
  }
  log.info(
    {
      chainId,
      uids: orderUids.length,
      requests,
      startBlock: startRaw,
      safeHead: safeHead.toString(),
      window: window.toString(),
    },
    'on-chain settlement history scan complete',
  );
  return { sources: found, safeHead };
}

/** Snapshot every sovereign UID pending at invocation start and scan each chain
 * exactly once. Database batching must not multiply the O(chain history) RPC
 * work: every batch reuses this immutable invocation-scoped result. A failed
 * chain is represented by null so every affected UID remains fail-closed. */
async function prepareOnchainAudit(repairRunStartedAt: Date): Promise<PreparedOnchainAudit> {
  const rows = await sql<{ chain_id: number; trade_uid: string }[]>`
    SELECT t.chain_id, '0x' || encode(t.trade_uid, 'hex') AS trade_uid
    FROM trades t
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS fill_count,
             COALESCE(BOOL_OR(
               f.fee_verified = false
               OR f.assessed_fee_bps IS NULL
               OR f.transaction_hash IS NULL
               OR f.user_address IS NULL
             ), false) AS incomplete
      FROM defillama_fills f
      WHERE f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
    ) state ON true
    WHERE t.chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
      AND (t.fee_verified = true OR state.fill_count > 0)
      AND (
        t.defillama_repair_checked_at IS NULL
        OR t.defillama_repair_checked_at < now() - INTERVAL '7 days'
        OR t.defillama_expected_fill_count IS NULL
        OR t.defillama_expected_fill_count <> state.fill_count
        OR state.incomplete
      )
      AND (t.defillama_repair_checked_at IS NULL
        OR t.defillama_repair_checked_at < ${repairRunStartedAt.toISOString()}::timestamptz)
  `;

  const uidsByChain = new Map<number, Set<`0x${string}`>>();
  for (const row of rows) {
    if (!process.env[`SETTLE_SCAN_START_BLOCK_${row.chain_id}`]) continue;
    const uids = uidsByChain.get(row.chain_id) ?? new Set<`0x${string}`>();
    uids.add(row.trade_uid as `0x${string}`);
    uidsByChain.set(row.chain_id, uids);
  }

  const byChain = new Map<number, OnchainScanResult | null>();
  let failedScans = 0;
  await Promise.all(
    [...uidsByChain].map(async ([chainId, uidSet]) => {
      const uids = [...uidSet];
      try {
        byChain.set(chainId, await onchainSourcesForUids(chainId, uids));
      } catch (err) {
        failedScans++;
        byChain.set(chainId, null);
        log.warn(
          { err, chainId, uids: uids.length },
          'on-chain settlement history fallback failed',
        );
      }
    }),
  );
  return { byChain, failedScans };
}

/** Read one unambiguous legacy Ophis flat policy from hash-verified appData.
 * Multiple partner policies remain pending because their reverse-order fee
 * application requires execution metadata no longer retained by a pruned API. */
function singleLegacyOphisFlatPolicyBps(meta: unknown): number | null {
  const raw = (meta as { metadata?: { partnerFee?: unknown } })?.metadata?.partnerFee;
  const fees = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (fees.length !== 1) return null;
  const fee = fees[0] as {
    recipient?: unknown;
    volumeBps?: unknown;
    bps?: unknown;
    surplusBps?: unknown;
    priceImprovementBps?: unknown;
    maxVolumeBps?: unknown;
  };
  if (
    typeof fee.recipient !== 'string' ||
    fee.recipient.toLowerCase() !== OPHIS_SAFE ||
    fee.surplusBps !== undefined ||
    fee.priceImprovementBps !== undefined ||
    fee.maxVolumeBps !== undefined ||
    (fee.volumeBps !== undefined && fee.bps !== undefined)
  )
    return null;
  const bps = fee.volumeBps !== undefined ? fee.volumeBps : fee.bps;
  return typeof bps === 'number' && Number.isInteger(bps) && bps > 0 && bps < 10_000
    ? Math.min(bps, LEGACY_MAX_PARTNER_FEE_BPS)
    : null;
}

/** Reproduce the historical backend's integer flat-volume assessment from the
 * executed settlement amounts. Trade.feeAmount is the unrelated sell-token
 * network fee: exclude it from a buy order's protocol-fee base, but never report
 * it as Ophis revenue. */
function legacyExecutedAssessment(
  source: SettlementSource,
  policyBps: number | null,
  settledAt: Date,
): string | null {
  if (policyBps === null || settledAt >= LEGACY_FLAT_FEE_CUTOFF || source.side === null)
    return null;
  const factor = policyBps / 10_000;
  const adjusted = source.side === 'sell' ? factor / (1 - factor) : factor / (1 + factor);
  // Mirrors backend number::U256Ext::checked_mul_f64 (1e18 scaling + truncation).
  const scaledFactor = BigInt(Math.trunc(adjusted * 1e18));
  const executed =
    source.side === 'sell'
      ? source.buyAmount
      : source.feeAmount === null
        ? 0n
        : source.sellAmount - source.feeAmount;
  if (executed <= 0n) return null;
  const assessed = (executed * scaledFactor) / 1_000_000_000_000_000_000n;
  const grossVolume =
    source.side === 'sell'
      ? source.buyAmount + assessed
      : source.feeAmount === null
        ? 0n
        : source.sellAmount - source.feeAmount;
  if (grossVolume <= 0n) return null;
  const scale = 100_000_000n;
  const scaledBps = (assessed * 10_000n * scale + grossVolume / 2n) / grossVolume;
  if (scaledBps > 10_001_000_000n) return null;
  return `${scaledBps / scale}.${(scaledBps % scale).toString().padStart(8, '0')}`;
}

function settlementKey(blockNumber: bigint | string, logIndex: number): string {
  return `${blockNumber.toString()}:${logIndex}`;
}

function usableUserAddress(address: string | null | undefined): `0x${string}` | null {
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) return null;
  if (ROUTER_WALLETS.includes(address.toLowerCase())) return null;
  return address.toLowerCase() as `0x${string}`;
}

/**
 * Repair immutable settlement identity from the exact-UID trade feed, falling back
 * to one complete GPv2Settlement history scan when a retired sovereign orderbook no
 * longer retains the UID. Existing fills are cross-checked rather than overwritten.
 * Every verified production aggregate, plus every decoder aggregate with a known
 * reporting fill, is audited. All of a UID's settlements are reconstructed before
 * its expected fill count is marked complete.
 */
async function repairDefiLlamaSettlementIdentityBatch(
  repairRunStartedAt: Date,
  repairLimit: number,
  preparedOnchain: PreparedOnchainAudit['byChain'],
): Promise<BatchRepairResult> {
  const identityRows = await sql<
    {
      chain_id: number;
      block_number: string;
      log_index: number;
      trade_uid: string;
      user_address: string | null;
    }[]
  >`
    SELECT f.chain_id, f.block_number::text, f.log_index,
           '0x' || encode(f.trade_uid, 'hex') AS trade_uid,
           CASE
             WHEN t.wallet IS NULL
               OR ('0x' || encode(t.wallet, 'hex')) = ANY(${ROUTER_WALLETS})
             THEN NULL
             ELSE '0x' || encode(t.wallet, 'hex')
           END AS user_address
    FROM defillama_fills f
    LEFT JOIN trades t ON t.chain_id = f.chain_id AND t.trade_uid = f.trade_uid
    WHERE f.chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
      AND (f.transaction_hash IS NULL OR f.user_address IS NULL)
    ORDER BY f.chain_id, f.block_number, f.log_index
    LIMIT ${repairLimit}
  `;

  const auditRows = await sql<
    {
      chain_id: number;
      trade_uid: string;
      user_address: string | null;
      volume_fee_bps: number | null;
      aggregate_fee_verified: boolean;
    }[]
  >`
    SELECT t.chain_id, '0x' || encode(t.trade_uid, 'hex') AS trade_uid,
           CASE
             WHEN ('0x' || encode(t.wallet, 'hex')) = ANY(${ROUTER_WALLETS}) THEN NULL
             ELSE '0x' || encode(t.wallet, 'hex')
           END AS user_address,
           t.volume_fee_bps,
           t.fee_verified AS aggregate_fee_verified
    FROM trades t
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS fill_count,
             COALESCE(BOOL_OR(
               f.fee_verified = false
               OR f.assessed_fee_bps IS NULL
               OR f.transaction_hash IS NULL
               OR f.user_address IS NULL
             ), false) AS incomplete
      FROM defillama_fills f
      WHERE f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
    ) state ON true
    WHERE t.chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
      AND (t.fee_verified = true OR state.fill_count > 0)
      AND (
        t.defillama_repair_checked_at IS NULL
        OR t.defillama_repair_checked_at < now() - INTERVAL '7 days'
        OR t.defillama_expected_fill_count IS NULL
        OR t.defillama_expected_fill_count <> state.fill_count
        OR state.incomplete
      )
      -- A failed UID is checkpointed too. It remains fail-closed and is retried
      -- next invocation, but cannot sort first forever and starve later batches.
      AND (t.defillama_repair_checked_at IS NULL
        OR t.defillama_repair_checked_at < ${repairRunStartedAt.toISOString()}::timestamptz)
    ORDER BY t.defillama_repair_checked_at ASC NULLS FIRST, t.chain_id, t.trade_uid
    LIMIT ${repairLimit}
  `;

  type Group = { chainId: number; blockNumber: bigint };
  const groups = new Map<string, Group>();
  for (const row of identityRows) {
    const key = `${row.chain_id}:${row.block_number}`;
    groups.set(key, { chainId: row.chain_id, blockNumber: BigInt(row.block_number) });
  }

  let identities = 0;
  let failedBlocks = 0;
  const pending: PendingDefiLlamaFill[] = [];
  for (const [key, group] of groups) {
    let logs: TradeEventLog[];
    try {
      logs = await blockTradeLogs(group.chainId, group.blockNumber);
    } catch (err) {
      failedBlocks++;
      log.warn(
        { err, chainId: group.chainId, blockNumber: group.blockNumber },
        'settlement identity block read failed',
      );
      continue;
    }

    for (const row of identityRows) {
      if (`${row.chain_id}:${row.block_number}` !== key) continue;
      const match = logs.find(
        (event) =>
          event.logIndex === row.log_index &&
          event.args.orderUid.toLowerCase() === row.trade_uid.toLowerCase(),
      );
      if (!match) continue;
      if (row.user_address) {
        await sql`
          UPDATE defillama_fills
          SET transaction_hash = COALESCE(transaction_hash, decode(${match.transactionHash.slice(2)}, 'hex')),
              user_address = COALESCE(user_address, decode(${row.user_address.slice(2)}, 'hex'))
          WHERE chain_id = ${row.chain_id}
            AND block_number = ${row.block_number}
            AND log_index = ${row.log_index}
            AND trade_uid = decode(${row.trade_uid.slice(2)}, 'hex')
        `;
      } else {
        await sql`
          UPDATE defillama_fills
          SET transaction_hash = COALESCE(transaction_hash, decode(${match.transactionHash.slice(2)}, 'hex'))
          WHERE chain_id = ${row.chain_id}
            AND block_number = ${row.block_number}
            AND log_index = ${row.log_index}
            AND trade_uid = decode(${row.trade_uid.slice(2)}, 'hex')
        `;
      }
      identities++;
    }
  }

  // The exact-UID feed is the normal authoritative settlement source. A configured
  // on-chain history supplements it even when it returns rows: a partially filled
  // order can straddle an orderbook pruning boundary.
  const sourcesByUid = new Map<string, SettlementSource[]>();
  const onchainValidationByUid = new Map<string, boolean>();
  for (const row of auditRows) {
    const uid = row.trade_uid as `0x${string}`;
    try {
      const apiTrades = await allTradesForUid(row.chain_id, uid);
      if (apiTrades.length > 0) {
        sourcesByUid.set(`${row.chain_id}:${uid.toLowerCase()}`, apiTrades.map(sourceFromApi));
      }
    } catch (err) {
      log.warn({ err, chainId: row.chain_id, uid }, 'exact-UID settlement source lookup failed');
    }
  }

  for (const row of auditRows) {
    if (!process.env[`SETTLE_SCAN_START_BLOCK_${row.chain_id}`]) continue;
    const uid = row.trade_uid as `0x${string}`;
    const key = `${row.chain_id}:${uid.toLowerCase()}`;
    const onchain = preparedOnchain.get(row.chain_id);
    if (!onchain) {
      // Never retain or reconstruct an API subset after the archive source that
      // validates its completeness failed. The expected count is cleared below.
      onchainValidationByUid.set(key, false);
      sourcesByUid.delete(key);
      continue;
    }

    const merged = new Map<string, SettlementSource>();
    // API rows win for the same settlement because they carry exact executed
    // fee-policy metadata; immutable on-chain rows add pruned settlements.
    for (const source of sourcesByUid.get(key) ?? []) {
      merged.set(settlementKey(source.blockNumber, source.logIndex), source);
    }
    const chainSources = onchain.sources.get(uid.toLowerCase()) ?? [];
    const onchainSettlements = new Set(
      chainSources.map((source) => settlementKey(source.blockNumber, source.logIndex)),
    );
    const apiHistoryValidated = [...merged.values()].every(
      (source) =>
        source.blockNumber > onchain.safeHead ||
        onchainSettlements.has(settlementKey(source.blockNumber, source.logIndex)),
    );
    onchainValidationByUid.set(
      key,
      apiHistoryValidated &&
        (chainSources.length > 0 ||
          [...merged.values()].every((source) => source.blockNumber > onchain.safeHead)),
    );
    for (const source of chainSources) {
      const settlement = settlementKey(source.blockNumber, source.logIndex);
      const apiSource = merged.get(settlement);
      if (apiSource) {
        merged.set(settlement, {
          ...apiSource,
          feeAmount: source.feeAmount,
          side: source.side,
          appDataHash: source.appDataHash,
          receiver: source.receiver,
        });
      } else {
        merged.set(settlement, source);
      }
    }
    if (merged.size > 0) {
      sourcesByUid.set(
        key,
        [...merged.values()].sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
        ),
      );
    }
  }

  const timestampsByBlock = new Map<string, Date>();
  const resolvedMetaByHash = new Map<string, unknown | null>();
  const completedAudits: Array<{ chainId: number; uid: `0x${string}`; fills: number }> = [];

  for (const row of auditRows) {
    const uid = row.trade_uid as `0x${string}`;
    const sources = sourcesByUid.get(`${row.chain_id}:${uid.toLowerCase()}`);
    if (!sources?.length) continue;
    try {
      const existingRows = await sql<
        {
          block_number: string;
          log_index: number;
          transaction_hash: string | null;
          user_address: string | null;
          settlement_timestamp: Date | string;
          sell_token: string;
          sell_amount: string;
          buy_token: string | null;
          buy_amount: string | null;
          volume_fee_bps: number | null;
          assessed_fee_bps: string | null;
        }[]
      >`
        SELECT block_number::text, log_index,
               CASE WHEN transaction_hash IS NULL THEN NULL
                 ELSE '0x' || encode(transaction_hash, 'hex') END AS transaction_hash,
               CASE WHEN user_address IS NULL THEN NULL
                 ELSE '0x' || encode(user_address, 'hex') END AS user_address,
               settlement_timestamp,
               '0x' || encode(sell_token, 'hex') AS sell_token,
               sell_amount::text,
               CASE WHEN buy_token IS NULL THEN NULL
                 ELSE '0x' || encode(buy_token, 'hex') END AS buy_token,
               buy_amount::text,
               volume_fee_bps,
               assessed_fee_bps::text
        FROM defillama_fills
        WHERE chain_id = ${row.chain_id}
          AND trade_uid = decode(${uid.slice(2)}, 'hex')
      `;
      const existingBySettlement = new Map(
        existingRows.map((fill) => [settlementKey(fill.block_number, fill.log_index), fill]),
      );

      let order: Awaited<ReturnType<typeof getOrder>> | null = null;
      let meta: unknown = null;
      try {
        order = await getOrder(row.chain_id, uid);
        meta = order.fullAppData ? JSON.parse(order.fullAppData) : null;
      } catch (err) {
        // Old sovereign orderbooks can retain neither the trade nor the order.
        // The calldata appData hash can still recover a content-addressed document.
        log.warn({ err, chainId: row.chain_id, uid }, 'settlement order metadata unavailable');
      }
      if (meta === null) {
        const hashes = new Set(
          sources.flatMap((source) =>
            source.appDataHash ? [source.appDataHash.toLowerCase() as `0x${string}`] : [],
          ),
        );
        if (hashes.size === 1) {
          const hash = [...hashes][0]!;
          if (!resolvedMetaByHash.has(hash)) {
            const fullAppData = await resolveAppData(row.chain_id, hash);
            let resolved: unknown = null;
            if (fullAppData !== null) {
              try {
                resolved = JSON.parse(fullAppData);
              } catch {
                resolved = null;
              }
            } else {
              log.warn(
                { chainId: row.chain_id, uid, appDataHash: hash },
                'settlement appData unavailable from content-addressed resolver',
              );
            }
            resolvedMetaByHash.set(hash, resolved);
          }
          meta = resolvedMetaByHash.get(hash) ?? null;
        } else if (hashes.size > 1) {
          log.error(
            { chainId: row.chain_id, uid, hashes: hashes.size },
            'settlement UID has conflicting appData hashes',
          );
        }
      }

      const reconstructed: PendingDefiLlamaFill[] = [];
      let complete =
        existingRows.length <= sources.length &&
        onchainValidationByUid.get(`${row.chain_id}:${uid.toLowerCase()}`) !== false;
      for (const source of sources) {
        const blockNumber = source.blockNumber;
        const key = `${row.chain_id}:${blockNumber}`;
        const existing = existingBySettlement.get(settlementKey(blockNumber, source.logIndex));

        // An existing immutable row must agree with the authoritative source. Do
        // not silently rewrite a conflicting transaction, token, or amount.
        if (
          existing &&
          ((existing.transaction_hash !== null &&
            existing.transaction_hash.toLowerCase() !== source.transactionHash.toLowerCase()) ||
            existing.sell_token.toLowerCase() !== source.sellToken.toLowerCase() ||
            BigInt(existing.sell_amount) !== source.sellAmount ||
            (existing.buy_token !== null &&
              existing.buy_token.toLowerCase() !== source.buyToken.toLowerCase()) ||
            (existing.buy_amount !== null && BigInt(existing.buy_amount) !== source.buyAmount))
        ) {
          complete = false;
          log.error(
            { chainId: row.chain_id, uid, blockNumber, logIndex: source.logIndex },
            'settlement source conflicts with persisted fill',
          );
          continue;
        }

        let settlementTimestamp = timestampsByBlock.get(key);
        if (!settlementTimestamp && existing?.settlement_timestamp) {
          settlementTimestamp =
            existing.settlement_timestamp instanceof Date
              ? existing.settlement_timestamp
              : new Date(existing.settlement_timestamp);
        }
        if (!settlementTimestamp) {
          try {
            const block = await getRpcClient(row.chain_id).getBlock({ blockNumber });
            settlementTimestamp = new Date(Number(block.timestamp) * 1000);
            timestampsByBlock.set(key, settlementTimestamp);
          } catch (err) {
            failedBlocks++;
            complete = false;
            log.warn(
              { err, chainId: row.chain_id, blockNumber },
              'settlement audit block read failed',
            );
            continue;
          }
        }

        let attributed: ReturnType<typeof attributeOrder> = null;
        if (meta !== null) {
          attributed = attributeOrder(
            meta,
            {
              owner: source.owner,
              receiver: order?.receiver ?? source.receiver,
              sellToken: source.sellToken,
              buyToken: source.buyToken,
              executedSell: source.sellAmount,
              executedBuy: source.buyAmount,
              tradeUid: uid,
              chainId: row.chain_id,
              blockNumber,
              blockTimestamp: settlementTimestamp,
            },
            DECODER_ETHFLOW_OWNERS,
          );
          if (attributed && order) {
            attributed.volumeFeeBps = affiliateFeeBpsForOrderCreatedAt(
              attributed.volumeFeeBps,
              new Date(order.creationDate),
            );
          }
        }

        const userAddress =
          usableUserAddress(attributed?.wallet) ??
          usableUserAddress(existing?.user_address) ??
          usableUserAddress(row.user_address) ??
          usableUserAddress(source.owner);
        const exactAssessment =
          source.apiTrade && order && meta !== null
            ? readAssessedOphisFeeBps(row.chain_id, order.class, meta, source.apiTrade)
            : null;
        const legacyPolicyBps = meta === null ? null : singleLegacyOphisFlatPolicyBps(meta);
        const legacyAssessment = row.aggregate_fee_verified
          ? legacyExecutedAssessment(source, legacyPolicyBps, settlementTimestamp)
          : null;
        const assessedFeeBps =
          exactAssessment ??
          existing?.assessed_fee_bps ??
          legacyAssessment ??
          (row.aggregate_fee_verified
            ? verifiedHostedZeroAssessment(row.chain_id, row.volume_fee_bps)
            : null);
        if (!userAddress) complete = false;
        if (assessedFeeBps === null) complete = false;
        if (!userAddress) continue;

        reconstructed.push({
          chainId: row.chain_id,
          blockNumber,
          logIndex: source.logIndex,
          tradeUid: uid,
          transactionHash: source.transactionHash,
          userAddress,
          settlementTimestamp,
          sellToken: source.sellToken,
          sellAmount: source.sellAmount,
          buyToken: source.buyToken,
          buyAmount: source.buyAmount,
          volumeFeeBps: attributed?.volumeFeeBps ?? existing?.volume_fee_bps ?? row.volume_fee_bps,
          assessedFeeBps,
          feeVerified: assessedFeeBps !== null,
        });
      }
      pending.push(...reconstructed);
      if (complete && reconstructed.length === sources.length) {
        completedAudits.push({ chainId: row.chain_id, uid, fills: sources.length });
      }
    } catch (err) {
      log.warn({ err, chainId: row.chain_id, uid }, 'exact-UID settlement audit failed');
    }
  }

  await upsertDefillamaFills(pending);

  // Stamp every attempted UID so an unrepairable first page cannot starve the
  // rest of the queue. Only a complete reconstruction receives an expected
  // count; incomplete attempts remain fail-closed and retry next invocation.
  const completedByUid = new Map(
    completedAudits.map((audit) => [`${audit.chainId}:${audit.uid.toLowerCase()}`, audit.fills]),
  );
  for (const row of auditRows) {
    const uid = row.trade_uid as `0x${string}`;
    const expected = completedByUid.get(`${row.chain_id}:${uid.toLowerCase()}`);
    if (expected === undefined) {
      await sql`
        UPDATE trades
        SET defillama_expected_fill_count = NULL,
            defillama_repair_checked_at = now()
        WHERE chain_id = ${row.chain_id}
          AND trade_uid = decode(${uid.slice(2)}, 'hex')
      `;
    } else {
      await sql`
        UPDATE trades
        SET defillama_expected_fill_count = ${expected},
            defillama_repair_checked_at = now()
        WHERE chain_id = ${row.chain_id}
          AND trade_uid = decode(${uid.slice(2)}, 'hex')
      `;
    }
  }

  // Decoder discovery is exhaustive but deliberately unverified for the rebate
  // money path. For public reporting, upgrade those fills through CoW's exact
  // order-UID trade lookup, which supplies the actually executed fee policies.
  // This is independent of owner tracking and therefore also handles contract
  // owners and the shared eth-flow router on hosted chains.
  const unverified = await sql<
    {
      chain_id: number;
      block_number: string;
      log_index: number;
      trade_uid: string;
      transaction_hash: string;
      settlement_timestamp: Date;
      sell_token: string;
      sell_amount: string;
      buy_token: string;
      buy_amount: string;
    }[]
  >`
    SELECT chain_id, block_number::text, log_index,
           '0x' || encode(trade_uid, 'hex') AS trade_uid,
           '0x' || encode(transaction_hash, 'hex') AS transaction_hash,
           settlement_timestamp,
           '0x' || encode(sell_token, 'hex') AS sell_token,
           sell_amount::text,
           '0x' || encode(buy_token, 'hex') AS buy_token,
           buy_amount::text
    FROM defillama_fills
    WHERE chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
      AND (fee_verified = false OR assessed_fee_bps IS NULL)
      AND transaction_hash IS NOT NULL
      AND buy_token IS NOT NULL
      AND buy_amount IS NOT NULL
    ORDER BY settlement_timestamp, chain_id, block_number, log_index
    LIMIT ${repairLimit}
  `;

  let fees = 0;
  for (const row of unverified) {
    const uid = row.trade_uid as `0x${string}`;
    try {
      const apiTrades = await allTradesForUid(row.chain_id, uid);
      const apiTrade = apiTrades.find(
        (candidate) =>
          candidate.orderUid.toLowerCase() === uid.toLowerCase() &&
          candidate.blockNumber === Number(row.block_number) &&
          candidate.logIndex === row.log_index,
      );
      if (!apiTrade) continue;
      const order = await getOrder(row.chain_id, uid);
      let meta: unknown;
      try {
        meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
      } catch {
        continue;
      }
      const attributed = attributeOrder(
        meta,
        {
          owner: apiTrade.owner,
          receiver: order.receiver,
          sellToken: row.sell_token as `0x${string}`,
          buyToken: row.buy_token as `0x${string}`,
          executedSell: BigInt(row.sell_amount),
          executedBuy: BigInt(row.buy_amount),
          tradeUid: uid,
          chainId: row.chain_id,
          blockNumber: BigInt(row.block_number),
          blockTimestamp: row.settlement_timestamp,
        },
        DECODER_ETHFLOW_OWNERS,
      );
      if (!attributed) continue;
      attributed.volumeFeeBps = affiliateFeeBpsForOrderCreatedAt(
        attributed.volumeFeeBps,
        new Date(order.creationDate),
      );
      const assessedFeeBps = readAssessedOphisFeeBps(row.chain_id, order.class, meta, apiTrade);
      if (assessedFeeBps === null) continue;
      await upsertDefillamaFills([
        {
          chainId: row.chain_id,
          blockNumber: BigInt(row.block_number),
          logIndex: row.log_index,
          tradeUid: uid,
          transactionHash: row.transaction_hash as `0x${string}`,
          userAddress: attributed.wallet,
          settlementTimestamp: row.settlement_timestamp,
          sellToken: row.sell_token as `0x${string}`,
          sellAmount: BigInt(row.sell_amount),
          buyToken: row.buy_token as `0x${string}`,
          buyAmount: BigInt(row.buy_amount),
          volumeFeeBps: attributed.volumeFeeBps,
          assessedFeeBps,
          feeVerified: true,
        },
      ]);
      fees++;
    } catch (err) {
      log.warn({ err, chainId: row.chain_id, uid }, 'reporting fee verification failed');
    }
  }

  return { identities, fills: pending.length, fees, failedBlocks, audits: auditRows.length };
}

/** Drain every audit row that was pending at invocation start. Sovereign archive
 * history is scanned once and shared across all database batches. Failed UIDs are
 * checkpointed by the batch worker, so they cannot monopolize the first page. */
export async function repairDefiLlamaSettlementIdentity(
  options: { repairLimit?: number } = {},
): Promise<RepairResult> {
  const repairLimit = options.repairLimit ?? REPAIR_LIMIT;
  if (!Number.isInteger(repairLimit) || repairLimit <= 0) {
    throw new Error('repairLimit must be a positive integer');
  }
  const repairRunStartedAt = new Date();
  const preparedOnchain = await prepareOnchainAudit(repairRunStartedAt);
  const total: RepairResult = {
    identities: 0,
    fills: 0,
    fees: 0,
    failedBlocks: preparedOnchain.failedScans,
  };
  while (true) {
    const batch = await repairDefiLlamaSettlementIdentityBatch(
      repairRunStartedAt,
      repairLimit,
      preparedOnchain.byChain,
    );
    total.identities += batch.identities;
    total.fills += batch.fills;
    total.fees += batch.fees;
    total.failedBlocks += batch.failedBlocks;
    if (batch.audits < repairLimit) return total;
  }
}
