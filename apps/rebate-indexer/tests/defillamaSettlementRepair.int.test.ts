import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';

type ApiTrade = {
  blockNumber: number;
  logIndex: number;
  orderUid: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  txHash: string;
  executedProtocolFees: Array<{ amount: string; token: string; policy: unknown }>;
};

const API_TRADES = new Map<string, ApiTrade[]>();
const ORDERS = new Map<string, Record<string, unknown>>();
const BLOCK_LOGS = new Map<string, unknown[]>();

vi.mock('../src/cow/client.js', () => ({
  SUPPORTED_CHAIN_IDS: [1, 11155111],
  listTrades: vi.fn(async (p: { chainId: number; orderUid: string; offset?: number; limit?: number }) => {
    const rows = API_TRADES.get(`${p.chainId}:${p.orderUid}`) ?? [];
    const offset = p.offset ?? 0;
    return rows.slice(offset, offset + (p.limit ?? 1_000));
  }),
  getOrder: vi.fn(async (chainId: number, uid: string) => {
    const order = ORDERS.get(`${chainId}:${uid}`);
    if (!order) throw new Error('order not found (mock)');
    return order;
  }),
}));

vi.mock('../src/rpc/client.js', () => ({
  getRpcClient: (chainId: number) => ({
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const rows: unknown[] = [];
      for (let block = fromBlock; block <= toBlock; block++) {
        rows.push(...(BLOCK_LOGS.get(`${chainId}:${block.toString()}`) ?? []));
      }
      return rows;
    }),
    getBlockNumber: vi.fn(async () => 400n),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: 1_786_000_000n + blockNumber,
    })),
  }),
}));

let container: StartedPostgreSqlContainer;
let sql: any;
let repairDefiLlamaSettlementIdentity:
  typeof import('../src/repair/defillamaSettlement.js')['repairDefiLlamaSettlementIdentity'];

const UID = (suffix: string) => `0x${suffix.padStart(112, '0')}`;
const PARTIAL_UID = UID('a1');
const IMPROVEMENT_UID = UID('a2');
const TESTNET_UID = UID('a3');
const FALLBACK_UID = UID('a4');
const OWNER = `0x${'12'.repeat(20)}`;
const SELL = `0x${'34'.repeat(20)}`;
const BUY = `0x${'56'.repeat(20)}`;
const OPHIS_SAFE = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';

const volumeMeta = JSON.stringify({
  appCode: 'ophis',
  metadata: { partnerFee: [{ recipient: OPHIS_SAFE, volumeBps: 1 }] },
});
const improvementMeta = JSON.stringify({
  appCode: 'ophis',
  metadata: { partnerFee: [{ recipient: OPHIS_SAFE, priceImprovementBps: 8_000, maxVolumeBps: 99 }] },
});

function apiTrade(uid: string, blockNumber: number, logIndex: number, sell: bigint, buy: bigint, improvement = false): ApiTrade {
  return {
    blockNumber,
    logIndex,
    orderUid: uid,
    owner: OWNER,
    sellToken: SELL,
    buyToken: BUY,
    sellAmount: sell.toString(),
    buyAmount: buy.toString(),
    txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    executedProtocolFees: [{
      amount: improvement ? '5' : '1',
      token: BUY,
      policy: improvement
        ? { priceImprovement: { factor: 0.8, maxVolumeFactor: 0.0099 } }
        : { volume: { factor: 0.0001 } },
    }],
  };
}

function tradeLog(trade: ApiTrade) {
  return {
    args: {
      owner: trade.owner,
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: BigInt(trade.sellAmount),
      buyAmount: BigInt(trade.buyAmount),
      orderUid: trade.orderUid,
    },
    transactionHash: trade.txHash,
    blockNumber: BigInt(trade.blockNumber),
    logIndex: trade.logIndex,
  };
}

async function insertAggregate(uid: string, chainId: number, sellAmount: bigint, buyAmount: bigint, volumeFeeBps: number | null) {
  await sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code,
      volume_fee_bps, fee_verified)
    VALUES (
      decode(${uid.slice(2)}, 'hex'), ${chainId}, decode(${OWNER.slice(2)}, 'hex'), 100,
      '2026-08-01T00:00:00.000Z', decode(${SELL.slice(2)}, 'hex'), decode(${BUY.slice(2)}, 'hex'),
      ${sellAmount.toString()}, ${buyAmount.toString()}, 'ophis', ${volumeFeeBps}, true)`;
}

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();

  const partialTrades = [
    apiTrade(PARTIAL_UID, 100, 3, 400n, 1_500n),
    apiTrade(PARTIAL_UID, 200, 7, 600n, 2_500n),
  ];
  const improvementTrades = [apiTrade(IMPROVEMENT_UID, 300, 9, 500n, 5_000n, true)];
  API_TRADES.set(`1:${PARTIAL_UID}`, partialTrades);
  API_TRADES.set(`1:${IMPROVEMENT_UID}`, improvementTrades);
  ORDERS.set(`1:${PARTIAL_UID}`, {
    uid: PARTIAL_UID, owner: OWNER, receiver: null, sellToken: SELL, buyToken: BUY,
    sellAmount: '1000', buyAmount: '4000', appData: `0x${'00'.repeat(32)}`,
    fullAppData: volumeMeta, creationDate: '2026-08-01T00:00:00.000Z', class: 'market', status: 'fulfilled',
  });
  ORDERS.set(`1:${IMPROVEMENT_UID}`, {
    uid: IMPROVEMENT_UID, owner: OWNER, receiver: null, sellToken: SELL, buyToken: BUY,
    sellAmount: '500', buyAmount: '5000', appData: `0x${'00'.repeat(32)}`,
    fullAppData: improvementMeta, creationDate: '2026-08-01T00:00:00.000Z', class: 'market', status: 'fulfilled',
  });
  for (const trade of [...partialTrades, ...improvementTrades]) {
    BLOCK_LOGS.set(`1:${trade.blockNumber}`, [tradeLog(trade)]);
  }

  await insertAggregate(PARTIAL_UID, 1, 1_000n, 4_000n, 1);
  await insertAggregate(IMPROVEMENT_UID, 1, 500n, 5_000n, null);
  await insertAggregate(TESTNET_UID, 11155111, 1n, 1n, 1);

  // Simulate a retired sovereign orderbook: neither exact-UID trades nor order
  // metadata remains, but both immutable settlement events are on-chain. The
  // verified aggregate's pre-policy flat rate and user remain authoritative.
  process.env.SETTLE_SCAN_START_BLOCK_130 = '100';
  const fallbackTrades = [
    apiTrade(FALLBACK_UID, 120, 2, 300n, 1_200n),
    apiTrade(FALLBACK_UID, 180, 8, 700n, 2_800n),
  ];
  for (const trade of fallbackTrades) {
    BLOCK_LOGS.set(`130:${trade.blockNumber}`, [tradeLog(trade)]);
  }
  await insertAggregate(FALLBACK_UID, 130, 1_000n, 4_000n, 10);

  // Seed only the first partial fill. The regression is that this row must not
  // make the UID appear complete and suppress the settlement in block 200.
  const first = partialTrades[0]!;
  await sql`
    INSERT INTO defillama_fills (
      chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
      settlement_timestamp, sell_token, sell_amount, buy_token, buy_amount,
      volume_fee_bps, assessed_fee_bps, fee_verified)
    VALUES (
      1, ${first.blockNumber}, ${first.logIndex}, decode(${PARTIAL_UID.slice(2)}, 'hex'),
      decode(${first.txHash.slice(2)}, 'hex'), decode(${OWNER.slice(2)}, 'hex'),
      '2026-08-01T00:00:00.000Z', decode(${SELL.slice(2)}, 'hex'), ${first.sellAmount},
      decode(${BUY.slice(2)}, 'hex'), ${first.buyAmount}, 1, 1, true)`;

  ({ repairDefiLlamaSettlementIdentity } = await import('../src/repair/defillamaSettlement.js'));
}, 180_000);

afterAll(async () => {
  await sql?.end?.({ timeout: 5 });
  await stopPg(container);
});

describe('repairDefiLlamaSettlementIdentity', () => {
  it('audits every exact-UID settlement block, including null flat-rate policies', async () => {
    await repairDefiLlamaSettlementIdentity();

    const partial = await sql`
      SELECT block_number::text AS block, assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills WHERE chain_id = 1 AND trade_uid = decode(${PARTIAL_UID.slice(2)}, 'hex')
      ORDER BY block_number` as Array<{ block: string; assessed: string | null; verified: boolean }>;
    expect(partial.map((row) => row.block)).toEqual(['100', '200']);
    expect(partial.every((row) => row.verified && row.assessed !== null)).toBe(true);

    const [improvement] = await sql<{ volume: number | null; assessed: string | null; verified: boolean }[]>`
      SELECT volume_fee_bps AS volume, assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills WHERE chain_id = 1 AND trade_uid = decode(${IMPROVEMENT_UID.slice(2)}, 'hex')`;
    expect(improvement).toMatchObject({ volume: null, verified: true });
    expect(improvement!.assessed).not.toBeNull();

    const audits = await sql`
      SELECT encode(trade_uid, 'hex') AS uid, defillama_expected_fill_count AS expected,
             defillama_repair_checked_at IS NOT NULL AS checked
      FROM trades ORDER BY chain_id, trade_uid` as Array<{ uid: string; expected: number | null; checked: boolean }>;
    expect(audits.find((row) => row.uid === PARTIAL_UID.slice(2))).toMatchObject({ expected: 2, checked: true });
    expect(audits.find((row) => row.uid === IMPROVEMENT_UID.slice(2))).toMatchObject({ expected: 1, checked: true });
    expect(audits.find((row) => row.uid === FALLBACK_UID.slice(2))).toMatchObject({ expected: 2, checked: true });
    expect(audits.find((row) => row.uid === TESTNET_UID.slice(2))).toMatchObject({ expected: null, checked: false });

    const fallback = await sql`
      SELECT block_number::text AS block, assessed_fee_bps::text AS assessed,
             fee_verified AS verified
      FROM defillama_fills
      WHERE chain_id = 130 AND trade_uid = decode(${FALLBACK_UID.slice(2)}, 'hex')
      ORDER BY block_number` as Array<{ block: string; assessed: string | null; verified: boolean }>;
    expect(fallback.map((row) => row.block)).toEqual(['120', '180']);
    expect(fallback.every((row) => row.verified && row.assessed === '10.00000000')).toBe(true);

    const [testnetFill] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM defillama_fills
      WHERE chain_id = 11155111 AND trade_uid = decode(${TESTNET_UID.slice(2)}, 'hex')`;
    expect(testnetFill!.count).toBe('0');
  });
});
