import { sql } from '../db/index.js';
import { getRpcClient } from '../rpc/client.js';
import { decodeFunctionData } from 'viem';
import { SETTLE_FN, TRADE_EVENT, settlementAddressFor } from '../cow/settleAbi.js';
import { getOrder, listTrades } from '../cow/client.js';
import {
  attributeOrder,
  DECODER_ETHFLOW_OWNERS,
  readAssessedOphisFeeBps,
  upsertDefillamaFills,
  type PendingDefiLlamaFill,
} from '../fetcher.js';
import { affiliateFeeBpsForOrderCreatedAt, SOVEREIGN_CHAIN_IDS } from '../affiliate/rates.js';
import { logger } from '../logger.js';
import { PRODUCTION_CHAIN_IDS } from '../stats-page.js';
import type { CowTrade } from '../cow/types.js';

const log = logger.child({ module: 'repair-defillama-settlement' });
const REPAIR_LIMIT = 500;
const API_PAGE_SIZE = 1_000;
const MAX_API_PAGES = 100;
// Completeness scans filter one settlement address and a small UID set, so begin
// with a wide archive window and halve on provider limits. Starting at the
// decoder's 2,000-block discovery window would require thousands of RPC calls.
const ONCHAIN_SCAN_WINDOW = 50_000n;
// The operated-chain improvement policy was deployed on 2026-08-11. Before this
// conservative boundary, an unclamped verified aggregate rate can reconstruct a
// legacy flat policy's integer execution. The nominal rate is never reported.
const LEGACY_FLAT_FEE_CUTOFF = new Date('2026-08-10T00:00:00.000Z');
const ROUTER_WALLETS: readonly string[] = Object.freeze([...DECODER_ETHFLOW_OWNERS]);

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
    tradeUid: trade.orderUid as `0x${string}`,
    transactionHash: trade.txHash as `0x${string}`,
    blockNumber: BigInt(trade.blockNumber),
    logIndex: trade.logIndex,
    apiTrade: trade,
  };
}

function sourceFromLog(event: TradeEventLog, side: SettlementSource['side']): SettlementSource {
  return {
    owner: event.args.owner,
    sellToken: event.args.sellToken,
    buyToken: event.args.buyToken,
    sellAmount: event.args.sellAmount,
    buyAmount: event.args.buyAmount,
    feeAmount: event.args.feeAmount,
    side,
    tradeUid: event.args.orderUid,
    transactionHash: event.transactionHash,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    apiTrade: null,
  };
}

function isRangeError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('-32602')
    || message.includes('block range')
    || message.includes('range too large')
    || message.includes('query returned more than')
    || message.includes('response size')
    || message.includes('limit exceeded');
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
): Promise<Map<string, SettlementSource[]>> {
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
  while (from <= safeHead) {
    const to = from + window - 1n > safeHead ? safeHead : from + window - 1n;
    let logs: TradeEventLog[];
    try {
      logs = (await client.getLogs({
        address: settlementAddressFor(chainId),
        event: TRADE_EVENT,
        fromBlock: from,
        toBlock: to,
      })) as unknown as TradeEventLog[];
    } catch (err) {
      if (isRangeError(err) && window > 1n) {
        window >>= 1n;
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
      let sides: Array<SettlementSource['side']> = transactionLogs.map(() => null);
      try {
        const transaction = await client.getTransaction({ hash: txHash as `0x${string}` });
        const decoded = decodeFunctionData({ abi: [SETTLE_FN], data: transaction.input });
        const args = decoded.args as unknown as readonly [
          readonly `0x${string}`[],
          readonly bigint[],
          readonly { sellTokenIndex: bigint; buyTokenIndex: bigint; flags: bigint }[],
          unknown,
        ];
        const tokens = args[0];
        const calldataTrades = args[2];
        if (calldataTrades.length !== transactionLogs.length) {
          throw new Error(`settle calldata has ${calldataTrades.length} trades for ${transactionLogs.length} Trade logs`);
        }
        sides = calldataTrades.map((trade, index) => {
          const event = transactionLogs[index]!;
          const sellToken = tokens[Number(trade.sellTokenIndex)];
          const buyToken = tokens[Number(trade.buyTokenIndex)];
          if (sellToken?.toLowerCase() !== event.args.sellToken.toLowerCase()
            || buyToken?.toLowerCase() !== event.args.buyToken.toLowerCase()) {
            throw new Error(`settle calldata token indexes disagree at Trade log ${event.logIndex}`);
          }
          return (trade.flags & 1n) === 0n ? 'sell' : 'buy';
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
        rows.push(sourceFromLog(event, sides[index] ?? null));
        found.set(uid, rows);
      }
    }
    from = to + 1n;
  }
  for (const rows of found.values()) {
    rows.sort((a, b) => a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber ? -1 : 1);
  }
  return found;
}

function verifiedHostedZeroAssessment(chainId: number, volumeFeeBps: number | null): string | null {
  // A verified zero means attribution examined the appData and found no settled
  // Ophis appData fee. That proves exact zero only on hosted chains: sovereign
  // market orders can prepend an operated price-improvement policy independently.
  if (volumeFeeBps === 0 && !SOVEREIGN_CHAIN_IDS.has(chainId)) return '0.00000000';
  return null;
}

/** Reconstruct the backend's integer flat-volume fee for immutable legacy
 * settlements. The nominal policy rate itself is never reported: integer token
 * rounding can make the effective executed rate differ materially on small fills.
 * A clamped aggregate cannot prove a policy above the clamp, so the 10 bps ceiling
 * remains pending unless the exact-UID API supplies executedProtocolFees. */
function legacyExecutedAssessment(
  source: SettlementSource,
  volumeFeeBps: number | null,
  settledAt: Date,
): string | null {
  if (volumeFeeBps === null || volumeFeeBps <= 0
    || volumeFeeBps >= 10 || settledAt >= LEGACY_FLAT_FEE_CUTOFF
    || source.side === null) return null;
  const factor = volumeFeeBps / 10_000;
  const adjusted = source.side === 'sell' ? factor / (1 - factor) : factor / (1 + factor);
  const scaledFactor = BigInt(Math.trunc(adjusted * 1e18));
  const executed = source.side === 'sell' ? source.buyAmount : source.sellAmount;
  const assessed = executed * scaledFactor / 1_000_000_000_000_000_000n;
  const grossVolume = source.side === 'sell'
    ? source.buyAmount + assessed
    : source.feeAmount === null ? 0n : source.sellAmount - source.feeAmount;
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
): Promise<BatchRepairResult> {
  const identityRows = await sql<{
    chain_id: number;
    block_number: string;
    log_index: number;
    trade_uid: string;
    user_address: string | null;
  }[]>`
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

  const auditRows = await sql<{
    chain_id: number;
    trade_uid: string;
    user_address: string | null;
    volume_fee_bps: number | null;
    aggregate_fee_verified: boolean;
  }[]>`
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
      log.warn({ err, chainId: group.chainId, blockNumber: group.blockNumber }, 'settlement identity block read failed');
      continue;
    }

    for (const row of identityRows) {
      if (`${row.chain_id}:${row.block_number}` !== key) continue;
      const match = logs.find((event) =>
        event.logIndex === row.log_index && event.args.orderUid.toLowerCase() === row.trade_uid.toLowerCase());
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
  const onchainUidsByChain = new Map<number, `0x${string}`[]>();
  for (const row of auditRows) {
    const uid = row.trade_uid as `0x${string}`;
    if (process.env[`SETTLE_SCAN_START_BLOCK_${row.chain_id}`]) {
      const uids = onchainUidsByChain.get(row.chain_id) ?? [];
      uids.push(uid);
      onchainUidsByChain.set(row.chain_id, uids);
    }
    try {
      const apiTrades = await allTradesForUid(row.chain_id, uid);
      if (apiTrades.length > 0) {
        sourcesByUid.set(`${row.chain_id}:${uid.toLowerCase()}`, apiTrades.map(sourceFromApi));
      }
    } catch (err) {
      log.warn({ err, chainId: row.chain_id, uid }, 'exact-UID settlement source lookup failed');
    }
  }

  for (const [chainId, uids] of onchainUidsByChain) {
    try {
      const onchain = await onchainSourcesForUids(chainId, uids);
      for (const uid of uids) {
        const key = `${chainId}:${uid.toLowerCase()}`;
        const merged = new Map<string, SettlementSource>();
        // API rows win for the same settlement because they carry exact executed
        // fee-policy metadata; immutable on-chain rows add pruned settlements.
        for (const source of sourcesByUid.get(key) ?? []) {
          merged.set(settlementKey(source.blockNumber, source.logIndex), source);
        }
        for (const source of onchain.get(uid.toLowerCase()) ?? []) {
          const settlement = settlementKey(source.blockNumber, source.logIndex);
          const apiSource = merged.get(settlement);
          if (apiSource) {
            merged.set(settlement, {
              ...apiSource,
              feeAmount: source.feeAmount,
              side: source.side,
            });
          } else {
            merged.set(settlement, source);
          }
        }
        if (merged.size > 0) {
          sourcesByUid.set(key, [...merged.values()].sort((a, b) => a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber ? -1 : 1));
        }
      }
    } catch (err) {
      failedBlocks++;
      log.warn({ err, chainId, uids: uids.length }, 'on-chain settlement history fallback failed');
    }
  }

  const timestampsByBlock = new Map<string, Date>();
  const completedAudits: Array<{ chainId: number; uid: `0x${string}`; fills: number }> = [];

  for (const row of auditRows) {
    const uid = row.trade_uid as `0x${string}`;
    const sources = sourcesByUid.get(`${row.chain_id}:${uid.toLowerCase()}`);
    if (!sources?.length) continue;
    try {
      const existingRows = await sql<{
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
      }[]>`
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
      const existingBySettlement = new Map(existingRows.map((fill) =>
        [settlementKey(fill.block_number, fill.log_index), fill]));

      let order: Awaited<ReturnType<typeof getOrder>> | null = null;
      let meta: unknown = null;
      try {
        order = await getOrder(row.chain_id, uid);
        meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
      } catch (err) {
        // Old sovereign orderbooks can retain neither the trade nor the order.
        // The immutable source + verified aggregate still suffice for legacy flat
        // policies, but post-policy fills remain incomplete and fail readiness.
        log.warn({ err, chainId: row.chain_id, uid }, 'settlement order metadata unavailable');
      }

      const reconstructed: PendingDefiLlamaFill[] = [];
      let complete = existingRows.length <= sources.length;
      for (const source of sources) {
        const blockNumber = source.blockNumber;
        const key = `${row.chain_id}:${blockNumber}`;
        const existing = existingBySettlement.get(settlementKey(blockNumber, source.logIndex));

        // An existing immutable row must agree with the authoritative source. Do
        // not silently rewrite a conflicting transaction, token, or amount.
        if (existing && (
          (existing.transaction_hash !== null
            && existing.transaction_hash.toLowerCase() !== source.transactionHash.toLowerCase())
          || existing.sell_token.toLowerCase() !== source.sellToken.toLowerCase()
          || BigInt(existing.sell_amount) !== source.sellAmount
          || (existing.buy_token !== null
            && existing.buy_token.toLowerCase() !== source.buyToken.toLowerCase())
          || (existing.buy_amount !== null && BigInt(existing.buy_amount) !== source.buyAmount)
        )) {
          complete = false;
          log.error({ chainId: row.chain_id, uid, blockNumber, logIndex: source.logIndex }, 'settlement source conflicts with persisted fill');
          continue;
        }

        let settlementTimestamp = timestampsByBlock.get(key);
        if (!settlementTimestamp && existing?.settlement_timestamp) {
          settlementTimestamp = existing.settlement_timestamp instanceof Date
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
            log.warn({ err, chainId: row.chain_id, blockNumber }, 'settlement audit block read failed');
            continue;
          }
        }

        let attributed: ReturnType<typeof attributeOrder> = null;
        if (order && meta !== null) {
          attributed = attributeOrder(meta, {
            owner: source.owner,
            receiver: order.receiver,
            sellToken: source.sellToken,
            buyToken: source.buyToken,
            executedSell: source.sellAmount,
            executedBuy: source.buyAmount,
            tradeUid: uid,
            chainId: row.chain_id,
            blockNumber,
            blockTimestamp: settlementTimestamp,
          }, DECODER_ETHFLOW_OWNERS);
          if (attributed) {
            attributed.volumeFeeBps = affiliateFeeBpsForOrderCreatedAt(
              attributed.volumeFeeBps,
              new Date(order.creationDate),
            );
          }
        }

        const userAddress = usableUserAddress(attributed?.wallet)
          ?? usableUserAddress(existing?.user_address)
          ?? usableUserAddress(row.user_address)
          ?? usableUserAddress(source.owner);
        const exactAssessment = source.apiTrade && order && meta !== null
          ? readAssessedOphisFeeBps(row.chain_id, order.class, meta, source.apiTrade)
          : null;
        const legacyAssessment = row.aggregate_fee_verified
          ? legacyExecutedAssessment(source, row.volume_fee_bps, settlementTimestamp)
          : null;
        const assessedFeeBps = exactAssessment
          ?? existing?.assessed_fee_bps
          ?? legacyAssessment
          ?? (row.aggregate_fee_verified
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
  const completedByUid = new Map(completedAudits.map((audit) =>
    [`${audit.chainId}:${audit.uid.toLowerCase()}`, audit.fills]));
  for (const row of auditRows) {
    const uid = row.trade_uid as `0x${string}`;
    const expected = completedByUid.get(`${row.chain_id}:${uid.toLowerCase()}`);
    if (expected === undefined) {
      await sql`
        UPDATE trades
        SET defillama_repair_checked_at = now()
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
  const unverified = await sql<{
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
  }[]>`
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
      const apiTrade = apiTrades.find((candidate) =>
        candidate.orderUid.toLowerCase() === uid.toLowerCase()
        && candidate.blockNumber === Number(row.block_number)
        && candidate.logIndex === row.log_index);
      if (!apiTrade) continue;
      const order = await getOrder(row.chain_id, uid);
      let meta: unknown;
      try {
        meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
      } catch {
        continue;
      }
      const attributed = attributeOrder(meta, {
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
      }, DECODER_ETHFLOW_OWNERS);
      if (!attributed) continue;
      attributed.volumeFeeBps = affiliateFeeBpsForOrderCreatedAt(
        attributed.volumeFeeBps,
        new Date(order.creationDate),
      );
      const assessedFeeBps = readAssessedOphisFeeBps(row.chain_id, order.class, meta, apiTrade);
      if (assessedFeeBps === null) continue;
      await upsertDefillamaFills([{
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
      }]);
      fees++;
    } catch (err) {
      log.warn({ err, chainId: row.chain_id, uid }, 'reporting fee verification failed');
    }
  }

  return { identities, fills: pending.length, fees, failedBlocks, audits: auditRows.length };
}

/** Drain every audit row that was pending at invocation start. Failed UIDs are
 * checkpointed by the batch worker, so they cannot monopolize the first page. */
export async function repairDefiLlamaSettlementIdentity(
  options: { repairLimit?: number } = {},
): Promise<RepairResult> {
  const repairLimit = options.repairLimit ?? REPAIR_LIMIT;
  if (!Number.isInteger(repairLimit) || repairLimit <= 0) {
    throw new Error('repairLimit must be a positive integer');
  }
  const repairRunStartedAt = new Date();
  const total: RepairResult = { identities: 0, fills: 0, fees: 0, failedBlocks: 0 };
  while (true) {
    const batch = await repairDefiLlamaSettlementIdentityBatch(repairRunStartedAt, repairLimit);
    total.identities += batch.identities;
    total.fills += batch.fills;
    total.fees += batch.fees;
    total.failedBlocks += batch.failedBlocks;
    if (batch.audits < repairLimit) return total;
  }
}
