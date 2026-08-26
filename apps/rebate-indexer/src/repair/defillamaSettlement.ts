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

const log = logger.child({ module: 'repair-defillama-settlement' });
const REPAIR_LIMIT = 500;

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

/**
 * Repair immutable settlement identity from the chain itself. This does not trust
 * orderbook retention: transaction hash, log index, per-fill amounts and UID all
 * come from GPv2Settlement's Trade event. Existing fills only receive missing
 * transaction/user fields. A verified aggregate trade with no fill is reconstructed
 * only when its verified flat fee is already present in the rebate ledger.
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
           CASE WHEN t.wallet IS NULL THEN NULL ELSE '0x' || encode(t.wallet, 'hex') END AS user_address
    FROM defillama_fills f
    LEFT JOIN trades t ON t.chain_id = f.chain_id AND t.trade_uid = f.trade_uid
    WHERE f.transaction_hash IS NULL OR f.user_address IS NULL
    ORDER BY f.chain_id, f.block_number, f.log_index
    LIMIT ${REPAIR_LIMIT}
  `;

  const missingFillRows = await sql<{
    chain_id: number;
    block_number: string;
    trade_uid: string;
    user_address: string;
    volume_fee_bps: number;
  }[]>`
    SELECT t.chain_id, t.block_number::text,
           '0x' || encode(t.trade_uid, 'hex') AS trade_uid,
           '0x' || encode(t.wallet, 'hex') AS user_address,
           t.volume_fee_bps
    FROM trades t
    WHERE t.fee_verified = true
      AND t.volume_fee_bps IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM defillama_fills f
        WHERE f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
      )
    ORDER BY t.chain_id, t.block_number
    LIMIT ${REPAIR_LIMIT}
  `;

  type Group = { chainId: number; blockNumber: bigint };
  const groups = new Map<string, Group>();
  for (const row of [...identityRows, ...missingFillRows]) {
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

    const missing = missingFillRows.filter((row) => `${row.chain_id}:${row.block_number}` === key);
    if (missing.length === 0) continue;
    let block: Awaited<ReturnType<ReturnType<typeof getRpcClient>['getBlock']>>;
    try {
      block = await getRpcClient(group.chainId).getBlock({ blockNumber: group.blockNumber });
    } catch (err) {
      failedBlocks++;
      log.warn({ err, chainId: group.chainId, blockNumber: group.blockNumber }, 'settlement timestamp block read failed');
      continue;
    }
    const settlementTimestamp = new Date(Number(block.timestamp) * 1000);
    for (const row of missing) {
      for (const event of logs.filter((candidate) => candidate.args.orderUid.toLowerCase() === row.trade_uid.toLowerCase())) {
        pending.push({
          chainId: row.chain_id,
          blockNumber: event.blockNumber,
          logIndex: event.logIndex,
          tradeUid: event.args.orderUid,
          transactionHash: event.transactionHash,
          userAddress: row.user_address as `0x${string}`,
          settlementTimestamp,
          sellToken: event.args.sellToken,
          sellAmount: event.args.sellAmount,
          buyToken: event.args.buyToken,
          buyAmount: event.args.buyAmount,
          volumeFeeBps: row.volume_fee_bps,
          assessedFeeBps: null,
          feeVerified: true,
        });
      }
    }
  }

  await upsertDefillamaFills(pending);

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
    WHERE fee_verified = false
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
      const apiTrades = await listTrades({ chainId: row.chain_id, orderUid: uid });
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
        assessedFeeBps: readAssessedOphisFeeBps(row.chain_id, order.class, meta, apiTrade),
        feeVerified: true,
      }]);
      fees++;
    } catch (err) {
      log.warn({ err, chainId: row.chain_id, uid }, 'reporting fee verification failed');
    }
  }

  return { identities, fills: pending.length, fees, failedBlocks };
}
