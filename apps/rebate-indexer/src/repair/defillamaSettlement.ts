import { sql } from '../db/index.js';
import { getRpcClient } from '../rpc/client.js';
import { TRADE_EVENT, settlementAddressFor } from '../cow/settleAbi.js';
import { getOrder, listTrades } from '../cow/client.js';
import {
  attributeOrder,
  DECODER_ETHFLOW_OWNERS,
  readAssessedOphisFeeBps,
  upsertDefillamaFills,
  type PendingDefiLlamaFill,
} from '../fetcher.js';
import { affiliateFeeBpsForOrderCreatedAt } from '../affiliate/rates.js';
import { logger } from '../logger.js';
import { PRODUCTION_CHAIN_IDS } from '../stats-page.js';
import type { CowTrade } from '../cow/types.js';

const log = logger.child({ module: 'repair-defillama-settlement' });
const REPAIR_LIMIT = 500;
const API_PAGE_SIZE = 1_000;
const MAX_API_PAGES = 100;
const ROUTER_WALLETS: readonly string[] = Object.freeze([...DECODER_ETHFLOW_OWNERS]);

interface TradeEventLog {
  args: {
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    sellAmount: bigint;
    buyAmount: bigint;
    orderUid: `0x${string}`;
  };
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

interface RepairResult {
  identities: number;
  fills: number;
  fees: number;
  failedBlocks: number;
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

/**
 * Repair immutable settlement identity from the chain itself. This does not trust
 * orderbook retention: transaction hash, log index, per-fill amounts and UID all
 * come from GPv2Settlement's Trade event. Existing fills only receive missing
 * transaction/user fields. Every verified production aggregate is periodically
 * audited against the exact-UID trade feed, and all of that UID's settlement blocks
 * are reconstructed before its expected fill count is marked complete.
 */
export async function repairDefiLlamaSettlementIdentity(): Promise<RepairResult> {
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
    LIMIT ${REPAIR_LIMIT}
  `;

  const auditRows = await sql<{
    chain_id: number;
    trade_uid: string;
  }[]>`
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
    WHERE t.fee_verified = true
      AND t.chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
      AND (
        t.defillama_repair_checked_at IS NULL
        OR t.defillama_repair_checked_at < now() - INTERVAL '7 days'
        OR t.defillama_expected_fill_count IS NULL
        OR t.defillama_expected_fill_count <> state.fill_count
        OR state.incomplete
      )
    ORDER BY t.defillama_repair_checked_at ASC NULLS FIRST, t.chain_id, t.trade_uid
    LIMIT ${REPAIR_LIMIT}
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

  // Cache immutable block data across UIDs: one settlement transaction can batch
  // several orders, and each block should cost at most one logs + block RPC pair.
  const logsByBlock = new Map<string, TradeEventLog[]>();
  const timestampsByBlock = new Map<string, Date>();
  const completedAudits: Array<{ chainId: number; uid: `0x${string}`; fills: number }> = [];

  for (const row of auditRows) {
    const uid = row.trade_uid as `0x${string}`;
    try {
      const [apiTrades, order] = await Promise.all([
        allTradesForUid(row.chain_id, uid),
        getOrder(row.chain_id, uid),
      ]);
      if (apiTrades.length === 0) continue;

      let meta: unknown;
      try {
        meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
      } catch {
        continue;
      }

      const reconstructed: PendingDefiLlamaFill[] = [];
      let complete = true;
      for (const apiTrade of apiTrades) {
        const blockNumber = BigInt(apiTrade.blockNumber);
        const key = `${row.chain_id}:${apiTrade.blockNumber}`;
        let logs = logsByBlock.get(key);
        let settlementTimestamp = timestampsByBlock.get(key);
        if (!logs || !settlementTimestamp) {
          try {
            const [freshLogs, block] = await Promise.all([
              blockTradeLogs(row.chain_id, blockNumber),
              getRpcClient(row.chain_id).getBlock({ blockNumber }),
            ]);
            logs = freshLogs;
            settlementTimestamp = new Date(Number(block.timestamp) * 1000);
            logsByBlock.set(key, logs);
            timestampsByBlock.set(key, settlementTimestamp);
          } catch (err) {
            failedBlocks++;
            complete = false;
            log.warn({ err, chainId: row.chain_id, blockNumber }, 'settlement audit block read failed');
            continue;
          }
        }

        const event = logs.find((candidate) =>
          candidate.logIndex === apiTrade.logIndex
          && candidate.args.orderUid.toLowerCase() === uid.toLowerCase());
        if (!event) {
          complete = false;
          log.warn({ chainId: row.chain_id, uid, blockNumber, logIndex: apiTrade.logIndex }, 'exact-UID settlement event missing from block');
          continue;
        }

        const attributed = attributeOrder(meta, {
          owner: apiTrade.owner,
          receiver: order.receiver,
          sellToken: event.args.sellToken,
          buyToken: event.args.buyToken,
          executedSell: event.args.sellAmount,
          executedBuy: event.args.buyAmount,
          tradeUid: uid,
          chainId: row.chain_id,
          blockNumber,
          blockTimestamp: settlementTimestamp,
        }, DECODER_ETHFLOW_OWNERS);
        if (!attributed) {
          complete = false;
          continue;
        }
        attributed.volumeFeeBps = affiliateFeeBpsForOrderCreatedAt(
          attributed.volumeFeeBps,
          new Date(order.creationDate),
        );
        const assessedFeeBps = readAssessedOphisFeeBps(row.chain_id, order.class, meta, apiTrade);
        if (assessedFeeBps === null) complete = false;
        reconstructed.push({
          chainId: row.chain_id,
          blockNumber,
          logIndex: event.logIndex,
          tradeUid: uid,
          transactionHash: event.transactionHash,
          userAddress: attributed.wallet,
          settlementTimestamp,
          sellToken: event.args.sellToken,
          sellAmount: event.args.sellAmount,
          buyToken: event.args.buyToken,
          buyAmount: event.args.buyAmount,
          volumeFeeBps: attributed.volumeFeeBps,
          assessedFeeBps,
          // A reconstructed fill is not reportable until the exact executed
          // assessment is present; flat-rate fallback would undercount PI/surplus.
          feeVerified: assessedFeeBps !== null,
        });
      }
      pending.push(...reconstructed);
      if (complete && reconstructed.length === apiTrades.length) {
        completedAudits.push({ chainId: row.chain_id, uid, fills: apiTrades.length });
      }
    } catch (err) {
      log.warn({ err, chainId: row.chain_id, uid }, 'exact-UID settlement audit failed');
    }
  }

  await upsertDefillamaFills(pending);

  // Stamp completeness only after every immutable event was reconstructed and
  // persisted with an exact executed assessment. A failed/partial audit remains
  // NULL or stale and therefore keeps readiness closed or is retried next run.
  for (const audit of completedAudits) {
    await sql`
      UPDATE trades
      SET defillama_expected_fill_count = ${audit.fills},
          defillama_repair_checked_at = now()
      WHERE chain_id = ${audit.chainId}
        AND trade_uid = decode(${audit.uid.slice(2)}, 'hex')
    `;
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
    LIMIT ${REPAIR_LIMIT}
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

  return { identities, fills: pending.length, fees, failedBlocks };
}
