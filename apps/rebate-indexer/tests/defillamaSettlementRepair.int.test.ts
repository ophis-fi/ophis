import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { encodeFunctionData, keccak256, stringToHex } from 'viem';
import { startPg, stopPg } from './fixtures/pgContainer.js';
import { SETTLE_FN } from '../src/cow/settleAbi.js';

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
const TX_INPUTS = new Map<string, `0x${string}`>();
const APP_DATA_DOCS = new Map<string, string>();
const FAILED_SCAN_CHAINS = new Set<number>();
const RATE_LIMIT_ONCE_CHAINS = new Set<number>();
const OVERLAPPING_RANGE_LIMITS = new Map<number, bigint>();
const BLOCK_HEADS = new Map<number, bigint>();
const GET_LOG_RANGES: Array<{ chainId: number; fromBlock: bigint; toBlock: bigint }> = [];

vi.mock('../src/cow/client.js', () => ({
  SUPPORTED_CHAIN_IDS: [1, 11155111],
  listTrades: vi.fn(
    async (p: { chainId: number; orderUid: string; offset?: number; limit?: number }) => {
      const rows = API_TRADES.get(`${p.chainId}:${p.orderUid}`) ?? [];
      const offset = p.offset ?? 0;
      return rows.slice(offset, offset + (p.limit ?? 1_000));
    },
  ),
  getOrder: vi.fn(async (chainId: number, uid: string) => {
    const order = ORDERS.get(`${chainId}:${uid}`);
    if (!order) throw new Error('order not found (mock)');
    return order;
  }),
}));

vi.mock('../src/rpc/client.js', () => ({
  getRpcClient: (chainId: number) => ({
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      GET_LOG_RANGES.push({ chainId, fromBlock, toBlock });
      if (RATE_LIMIT_ONCE_CHAINS.delete(chainId)) {
        throw new Error('429 rate limit exceeded: response size temporarily unavailable (mock)');
      }
      const overlappingRangeLimit = OVERLAPPING_RANGE_LIMITS.get(chainId);
      if (overlappingRangeLimit !== undefined && toBlock - fromBlock + 1n > overlappingRangeLimit) {
        throw new Error('response size exceeds capacity (mock)');
      }
      if (FAILED_SCAN_CHAINS.has(chainId)) throw new Error('archive unavailable (mock)');
      const rows: unknown[] = [];
      for (const [key, logs] of BLOCK_LOGS) {
        const [logChainId, rawBlock] = key.split(':');
        const block = BigInt(rawBlock!);
        if (Number(logChainId) === chainId && block >= fromBlock && block <= toBlock) {
          rows.push(...logs);
        }
      }
      return rows;
    }),
    getBlockNumber: vi.fn(async () => BLOCK_HEADS.get(chainId) ?? 400n),
    getTransaction: vi.fn(async ({ hash }: { hash: string }) => ({
      input: TX_INPUTS.get(hash) ?? '0x',
    })),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: blockNumber >= 350n ? 1_787_000_000n + blockNumber : 1_786_000_000n + blockNumber,
    })),
  }),
}));

vi.mock('../src/cow/appDataResolver.js', () => ({
  resolveAppData: vi.fn(
    async (_chainId: number, hash: string) => APP_DATA_DOCS.get(hash.toLowerCase()) ?? null,
  ),
}));

let container: StartedPostgreSqlContainer;
let sql: any;
let repairDefiLlamaSettlementIdentity: (typeof import('../src/repair/defillamaSettlement.js'))['repairDefiLlamaSettlementIdentity'];

const UID = (suffix: string) => `0x${suffix.padStart(112, '0')}`;
const PARTIAL_UID = UID('a1');
const IMPROVEMENT_UID = UID('a2');
const TESTNET_UID = UID('a3');
const FALLBACK_UID = UID('a4');
const ZERO_UID = UID('a5');
const SOVEREIGN_ZERO_UID = UID('a6');
const PARTIAL_API_UID = UID('b0');
const FAILED_UID = UID('b1');
const DRAINED_UID_1 = UID('b2');
const DRAINED_UID_2 = UID('b3');
const DECODER_UID = UID('b4');
const SCAN_FAILURE_UID = UID('b5');
const BUY_NETWORK_UID = UID('b6');
const STACKED_POLICY_UID = UID('b7');
const RATE_LIMIT_UID = UID('b8');
const OVERLAPPING_RANGE_UID = UID('b9');
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
  metadata: {
    partnerFee: [{ recipient: OPHIS_SAFE, priceImprovementBps: 8_000, maxVolumeBps: 99 }],
  },
});
const legacyRawMeta = JSON.stringify({
  appCode: 'ophis',
  metadata: { partnerFee: [{ recipient: OPHIS_SAFE, volumeBps: 250 }] },
});
const stackedMeta = JSON.stringify({
  appCode: 'ophis',
  metadata: {
    partnerFee: [
      { recipient: OPHIS_SAFE, volumeBps: 1 },
      { recipient: `0x${'98'.repeat(20)}`, volumeBps: 2 },
    ],
  },
});
const VOLUME_META_HASH = keccak256(stringToHex(volumeMeta));
const LEGACY_RAW_META_HASH = keccak256(stringToHex(legacyRawMeta));
const STACKED_META_HASH = keccak256(stringToHex(stackedMeta));

function apiTrade(
  uid: string,
  blockNumber: number,
  logIndex: number,
  sell: bigint,
  buy: bigint,
  improvement = false,
): ApiTrade {
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
    executedProtocolFees: [
      {
        amount: improvement ? '5' : '1',
        token: BUY,
        policy: improvement
          ? { priceImprovement: { factor: 0.8, maxVolumeFactor: 0.0099 } }
          : { volume: { factor: 0.0001 } },
      },
    ],
  };
}

function tradeLog(trade: ApiTrade, feeAmount = 0n) {
  return {
    args: {
      owner: trade.owner,
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: BigInt(trade.sellAmount),
      buyAmount: BigInt(trade.buyAmount),
      feeAmount,
      orderUid: trade.orderUid,
    },
    transactionHash: trade.txHash,
    blockNumber: BigInt(trade.blockNumber),
    logIndex: trade.logIndex,
  };
}

function settlementInput(
  trade: ApiTrade,
  side: 'sell' | 'buy' = 'sell',
  appDataHash: `0x${string}` = VOLUME_META_HASH,
): `0x${string}` {
  return encodeFunctionData({
    abi: [SETTLE_FN],
    functionName: 'settle',
    args: [
      [SELL, BUY],
      [1n, 1n],
      [
        {
          sellTokenIndex: 0n,
          buyTokenIndex: 1n,
          receiver: OWNER,
          sellAmount: BigInt(trade.sellAmount),
          buyAmount: BigInt(trade.buyAmount),
          validTo: 0,
          appData: appDataHash,
          feeAmount: 0n,
          flags: side === 'sell' ? 0n : 1n,
          executedAmount: BigInt(trade.sellAmount),
          signature: '0x',
        },
      ],
      [[], [], []],
    ],
  });
}

async function insertAggregate(
  uid: string,
  chainId: number,
  sellAmount: bigint,
  buyAmount: bigint,
  volumeFeeBps: number | null,
  feeVerified = true,
) {
  await sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code,
      volume_fee_bps, fee_verified)
    VALUES (
      decode(${uid.slice(2)}, 'hex'), ${chainId}, decode(${OWNER.slice(2)}, 'hex'), 100,
      '2026-08-01T00:00:00.000Z', decode(${SELL.slice(2)}, 'hex'), decode(${BUY.slice(2)}, 'hex'),
      ${sellAmount.toString()}, ${buyAmount.toString()}, 'ophis', ${volumeFeeBps}, ${feeVerified})`;
}

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  APP_DATA_DOCS.set(VOLUME_META_HASH.toLowerCase(), volumeMeta);
  APP_DATA_DOCS.set(LEGACY_RAW_META_HASH.toLowerCase(), legacyRawMeta);
  APP_DATA_DOCS.set(STACKED_META_HASH.toLowerCase(), stackedMeta);

  const partialTrades = [
    apiTrade(PARTIAL_UID, 100, 3, 400n, 1_500n),
    apiTrade(PARTIAL_UID, 200, 7, 600n, 2_500n),
  ];
  const improvementTrades = [apiTrade(IMPROVEMENT_UID, 300, 9, 500n, 5_000n, true)];
  const zeroTrades = [apiTrade(ZERO_UID, 350, 4, 200n, 800n)];
  zeroTrades[0]!.executedProtocolFees = [];
  const sovereignZeroTrades = [apiTrade(SOVEREIGN_ZERO_UID, 360, 5, 200n, 800n)];
  sovereignZeroTrades[0]!.executedProtocolFees = [];
  API_TRADES.set(`1:${PARTIAL_UID}`, partialTrades);
  API_TRADES.set(`1:${IMPROVEMENT_UID}`, improvementTrades);
  API_TRADES.set(`56:${ZERO_UID}`, zeroTrades);
  API_TRADES.set(`10:${SOVEREIGN_ZERO_UID}`, sovereignZeroTrades);
  ORDERS.set(`1:${PARTIAL_UID}`, {
    uid: PARTIAL_UID,
    owner: OWNER,
    receiver: null,
    sellToken: SELL,
    buyToken: BUY,
    sellAmount: '1000',
    buyAmount: '4000',
    appData: `0x${'00'.repeat(32)}`,
    fullAppData: volumeMeta,
    creationDate: '2026-08-01T00:00:00.000Z',
    class: 'market',
    status: 'fulfilled',
  });
  ORDERS.set(`1:${IMPROVEMENT_UID}`, {
    uid: IMPROVEMENT_UID,
    owner: OWNER,
    receiver: null,
    sellToken: SELL,
    buyToken: BUY,
    sellAmount: '500',
    buyAmount: '5000',
    appData: `0x${'00'.repeat(32)}`,
    fullAppData: improvementMeta,
    creationDate: '2026-08-01T00:00:00.000Z',
    class: 'market',
    status: 'fulfilled',
  });
  ORDERS.set(`56:${ZERO_UID}`, {
    uid: ZERO_UID,
    owner: OWNER,
    receiver: null,
    sellToken: SELL,
    buyToken: BUY,
    sellAmount: '200',
    buyAmount: '800',
    appData: `0x${'00'.repeat(32)}`,
    fullAppData: JSON.stringify({ appCode: 'ophis', metadata: {} }),
    creationDate: '2026-08-20T00:00:00.000Z',
    class: 'market',
    status: 'fulfilled',
  });
  ORDERS.set(`10:${SOVEREIGN_ZERO_UID}`, {
    uid: SOVEREIGN_ZERO_UID,
    owner: OWNER,
    receiver: null,
    sellToken: SELL,
    buyToken: BUY,
    sellAmount: '200',
    buyAmount: '800',
    appData: `0x${'00'.repeat(32)}`,
    fullAppData: JSON.stringify({ appCode: 'ophis', metadata: {} }),
    creationDate: '2026-08-20T00:00:00.000Z',
    class: 'market',
    status: 'fulfilled',
  });
  for (const trade of [
    ...partialTrades,
    ...improvementTrades,
    ...zeroTrades,
    ...sovereignZeroTrades,
  ]) {
    const chainId = trade === zeroTrades[0] ? 56 : trade === sovereignZeroTrades[0] ? 10 : 1;
    BLOCK_LOGS.set(`${chainId}:${trade.blockNumber}`, [tradeLog(trade)]);
  }

  await insertAggregate(PARTIAL_UID, 1, 1_000n, 4_000n, 1);
  await insertAggregate(IMPROVEMENT_UID, 1, 500n, 5_000n, null);
  await insertAggregate(TESTNET_UID, 11155111, 1n, 1n, 1);
  await insertAggregate(ZERO_UID, 56, 200n, 800n, 0);
  await insertAggregate(SOVEREIGN_ZERO_UID, 10, 200n, 800n, 0);

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
    TX_INPUTS.set(trade.txHash, settlementInput(trade, 'sell', LEGACY_RAW_META_HASH));
  }
  // The aggregate is clamped to 10 bps and appData names a raw 250-bps policy.
  // The legacy backend capped that policy to 100 bps before applying integer
  // rounding to each immutable executed settlement amount.
  await insertAggregate(FALLBACK_UID, 130, 1_000n, 4_000n, 10);

  // A legacy buy-side Trade includes the sell-token network fee in sellAmount.
  // Only the fee-free 10,000,000 units are the protocol-fee execution base.
  const buyNetworkTrade = apiTrade(BUY_NETWORK_UID, 230, 2, 11_000_000n, 5_000_000n);
  BLOCK_LOGS.set('130:230', [tradeLog(buyNetworkTrade, 1_000_000n)]);
  TX_INPUTS.set(buyNetworkTrade.txHash, settlementInput(buyNetworkTrade, 'buy'));
  await insertAggregate(BUY_NETWORK_UID, 130, 11_000_000n, 5_000_000n, 1);

  // Metadata with another sequential partner policy cannot prove the Ophis
  // executed amount after orderbook pruning, so it must remain incomplete.
  const stackedTrade = apiTrade(STACKED_POLICY_UID, 250, 3, 1_000_000n, 5_000_000n);
  BLOCK_LOGS.set('130:250', [tradeLog(stackedTrade)]);
  TX_INPUTS.set(stackedTrade.txHash, settlementInput(stackedTrade, 'sell', STACKED_META_HASH));
  await insertAggregate(STACKED_POLICY_UID, 130, 1_000_000n, 5_000_000n, 1);

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

    const partial = (await sql`
      SELECT block_number::text AS block, assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills WHERE chain_id = 1 AND trade_uid = decode(${PARTIAL_UID.slice(2)}, 'hex')
      ORDER BY block_number`) as Array<{
      block: string;
      assessed: string | null;
      verified: boolean;
    }>;
    expect(partial.map((row) => row.block)).toEqual(['100', '200']);
    expect(partial.every((row) => row.verified && row.assessed !== null)).toBe(true);

    const [improvement] = await sql<
      { volume: number | null; assessed: string | null; verified: boolean }[]
    >`
      SELECT volume_fee_bps AS volume, assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills WHERE chain_id = 1 AND trade_uid = decode(${IMPROVEMENT_UID.slice(2)}, 'hex')`;
    expect(improvement).toMatchObject({ volume: null, verified: true });
    expect(improvement!.assessed).not.toBeNull();

    const audits = (await sql`
      SELECT encode(trade_uid, 'hex') AS uid, defillama_expected_fill_count AS expected,
             defillama_repair_checked_at IS NOT NULL AS checked
      FROM trades ORDER BY chain_id, trade_uid`) as Array<{
      uid: string;
      expected: number | null;
      checked: boolean;
    }>;
    expect(audits.find((row) => row.uid === PARTIAL_UID.slice(2))).toMatchObject({
      expected: 2,
      checked: true,
    });
    expect(audits.find((row) => row.uid === IMPROVEMENT_UID.slice(2))).toMatchObject({
      expected: 1,
      checked: true,
    });
    expect(audits.find((row) => row.uid === FALLBACK_UID.slice(2))).toMatchObject({
      expected: 2,
      checked: true,
    });
    expect(audits.find((row) => row.uid === BUY_NETWORK_UID.slice(2))).toMatchObject({
      expected: 1,
      checked: true,
    });
    expect(audits.find((row) => row.uid === STACKED_POLICY_UID.slice(2))).toMatchObject({
      expected: null,
      checked: true,
    });
    expect(audits.find((row) => row.uid === ZERO_UID.slice(2))).toMatchObject({
      expected: 1,
      checked: true,
    });
    expect(audits.find((row) => row.uid === SOVEREIGN_ZERO_UID.slice(2))).toMatchObject({
      expected: null,
      checked: true,
    });
    expect(audits.find((row) => row.uid === TESTNET_UID.slice(2))).toMatchObject({
      expected: null,
      checked: false,
    });

    const fallback = (await sql`
      SELECT block_number::text AS block, assessed_fee_bps::text AS assessed,
             fee_verified AS verified
      FROM defillama_fills
      WHERE chain_id = 130 AND trade_uid = decode(${FALLBACK_UID.slice(2)}, 'hex')
      ORDER BY block_number`) as Array<{
      block: string;
      assessed: string | null;
      verified: boolean;
    }>;
    expect(fallback.map((row) => row.block)).toEqual(['120', '180']);
    expect(fallback).toEqual([
      { block: '120', assessed: '99.00990099', verified: true },
      { block: '180', assessed: '99.00990099', verified: true },
    ]);

    const [buyNetwork] = await sql<{ assessed: string | null; verified: boolean }[]>`
      SELECT assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills
      WHERE chain_id = 130 AND trade_uid = decode(${BUY_NETWORK_UID.slice(2)}, 'hex')`;
    expect(buyNetwork).toEqual({ assessed: '0.99900000', verified: true });

    const [stacked] = await sql<{ assessed: string | null; verified: boolean }[]>`
      SELECT assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills
      WHERE chain_id = 130 AND trade_uid = decode(${STACKED_POLICY_UID.slice(2)}, 'hex')`;
    expect(stacked).toEqual({ assessed: null, verified: false });

    const [zero] = await sql<{ assessed: string | null; verified: boolean }[]>`
      SELECT assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills
      WHERE chain_id = 56 AND trade_uid = decode(${ZERO_UID.slice(2)}, 'hex')`;
    expect(zero).toMatchObject({ assessed: '0.00000000', verified: true });

    const [sovereignZero] = await sql<{ assessed: string | null; verified: boolean }[]>`
      SELECT assessed_fee_bps::text AS assessed, fee_verified AS verified
      FROM defillama_fills
      WHERE chain_id = 10 AND trade_uid = decode(${SOVEREIGN_ZERO_UID.slice(2)}, 'hex')`;
    expect(sovereignZero).toMatchObject({ assessed: null, verified: false });

    const [testnetFill] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM defillama_fills
      WHERE chain_id = 11155111 AND trade_uid = decode(${TESTNET_UID.slice(2)}, 'hex')`;
    expect(testnetFill!.count).toBe('0');
  });

  it('supplements partial API history, audits decoder aggregates, and drains past failures', async () => {
    const archived = apiTrade(PARTIAL_API_UID, 220, 2, 300n, 12_000n);
    const retained = apiTrade(PARTIAL_API_UID, 240, 6, 700n, 28_000n);
    API_TRADES.set(`130:${PARTIAL_API_UID}`, [retained]);
    ORDERS.set(`130:${PARTIAL_API_UID}`, {
      uid: PARTIAL_API_UID,
      owner: OWNER,
      receiver: null,
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: '1000',
      buyAmount: '40000',
      appData: `0x${'00'.repeat(32)}`,
      fullAppData: volumeMeta,
      creationDate: '2026-08-01T00:00:00.000Z',
      class: 'market',
      status: 'fulfilled',
    });
    for (const trade of [archived, retained]) {
      BLOCK_LOGS.set(`130:${trade.blockNumber}`, [tradeLog(trade)]);
      TX_INPUTS.set(trade.txHash, settlementInput(trade));
    }
    await insertAggregate(PARTIAL_API_UID, 130, 1_000n, 40_000n, 1);

    const decoderTrades = [
      apiTrade(DECODER_UID, 260, 1, 400n, 1_500n),
      apiTrade(DECODER_UID, 280, 5, 600n, 2_500n),
    ];
    API_TRADES.set(`1:${DECODER_UID}`, decoderTrades);
    ORDERS.set(`1:${DECODER_UID}`, {
      uid: DECODER_UID,
      owner: OWNER,
      receiver: null,
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: '1000',
      buyAmount: '4000',
      appData: `0x${'00'.repeat(32)}`,
      fullAppData: volumeMeta,
      creationDate: '2026-08-01T00:00:00.000Z',
      class: 'market',
      status: 'fulfilled',
    });
    await insertAggregate(DECODER_UID, 1, 1_000n, 4_000n, 0, false);
    const known = decoderTrades[1]!;
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
        settlement_timestamp, sell_token, sell_amount, buy_token, buy_amount,
        volume_fee_bps, assessed_fee_bps, fee_verified)
      VALUES (
        1, ${known.blockNumber}, ${known.logIndex}, decode(${DECODER_UID.slice(2)}, 'hex'),
        decode(${known.txHash.slice(2)}, 'hex'), decode(${OWNER.slice(2)}, 'hex'),
        '2026-08-01T00:00:00.000Z', decode(${SELL.slice(2)}, 'hex'), ${known.sellAmount},
        decode(${BUY.slice(2)}, 'hex'), ${known.buyAmount}, 0, NULL, false)`;

    for (const [uid, block] of [
      [DRAINED_UID_1, 310],
      [DRAINED_UID_2, 320],
    ] as const) {
      const trade = apiTrade(uid, block, 1, 100n, 1_000n);
      API_TRADES.set(`56:${uid}`, [trade]);
      ORDERS.set(`56:${uid}`, {
        uid,
        owner: OWNER,
        receiver: null,
        sellToken: SELL,
        buyToken: BUY,
        sellAmount: '100',
        buyAmount: '1000',
        appData: `0x${'00'.repeat(32)}`,
        fullAppData: volumeMeta,
        creationDate: '2026-08-01T00:00:00.000Z',
        class: 'market',
        status: 'fulfilled',
      });
      BLOCK_LOGS.set(`56:${block}`, [tradeLog(trade)]);
      TX_INPUTS.set(trade.txHash, settlementInput(trade));
      await insertAggregate(uid, 56, 100n, 1_000n, 1);
    }
    await insertAggregate(FAILED_UID, 56, 100n, 1_000n, 1);

    process.env.SETTLE_SCAN_START_BLOCK_56 = '300';
    const scanCallsBefore = GET_LOG_RANGES.filter(
      ({ chainId, fromBlock, toBlock }) =>
        chainId === 56 && fromBlock === 300n && toBlock > fromBlock,
    ).length;
    try {
      await repairDefiLlamaSettlementIdentity({ repairLimit: 1 });
    } finally {
      delete process.env.SETTLE_SCAN_START_BLOCK_56;
    }
    const scanCallsAfter = GET_LOG_RANGES.filter(
      ({ chainId, fromBlock, toBlock }) =>
        chainId === 56 && fromBlock === 300n && toBlock > fromBlock,
    ).length;
    expect(scanCallsAfter - scanCallsBefore).toBe(1);

    const [partialApi] = await sql<{ count: string; expected: number | null }[]>`
      SELECT COUNT(f.*)::text AS count, MAX(t.defillama_expected_fill_count) AS expected
      FROM trades t LEFT JOIN defillama_fills f
        ON f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
      WHERE t.chain_id = 130 AND t.trade_uid = decode(${PARTIAL_API_UID.slice(2)}, 'hex')`;
    expect(partialApi).toEqual({ count: '2', expected: 2 });

    const [decoder] = await sql<
      { count: string; expected: number | null; aggregate_verified: boolean }[]
    >`
      SELECT COUNT(f.*)::text AS count, MAX(t.defillama_expected_fill_count) AS expected,
             BOOL_OR(t.fee_verified) AS aggregate_verified
      FROM trades t LEFT JOIN defillama_fills f
        ON f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
      WHERE t.chain_id = 1 AND t.trade_uid = decode(${DECODER_UID.slice(2)}, 'hex')`;
    expect(decoder).toEqual({ count: '2', expected: 2, aggregate_verified: false });

    const drained = await sql<{ uid: string; expected: number | null; checked: boolean }[]>`
      SELECT encode(trade_uid, 'hex') AS uid, defillama_expected_fill_count AS expected,
             defillama_repair_checked_at IS NOT NULL AS checked
      FROM trades
      WHERE trade_uid IN (
        decode(${FAILED_UID.slice(2)}, 'hex'),
        decode(${DRAINED_UID_1.slice(2)}, 'hex'),
        decode(${DRAINED_UID_2.slice(2)}, 'hex'))
      ORDER BY trade_uid`;
    expect(drained).toEqual([
      { uid: FAILED_UID.slice(2), expected: null, checked: true },
      { uid: DRAINED_UID_1.slice(2), expected: 1, checked: true },
      { uid: DRAINED_UID_2.slice(2), expected: 1, checked: true },
    ]);
  });

  it('keeps API settlements fail-closed when configured on-chain validation fails', async () => {
    process.env.SETTLE_SCAN_START_BLOCK_4663 = '100';
    const trade = apiTrade(SCAN_FAILURE_UID, 330, 3, 100n, 1_000n);
    API_TRADES.set(`4663:${SCAN_FAILURE_UID}`, [trade]);
    ORDERS.set(`4663:${SCAN_FAILURE_UID}`, {
      uid: SCAN_FAILURE_UID,
      owner: OWNER,
      receiver: null,
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: '100',
      buyAmount: '1000',
      appData: VOLUME_META_HASH,
      fullAppData: volumeMeta,
      creationDate: '2026-08-01T00:00:00.000Z',
      class: 'market',
      status: 'fulfilled',
    });
    await insertAggregate(SCAN_FAILURE_UID, 4663, 100n, 1_000n, 1);
    await sql`
      UPDATE trades
      SET defillama_expected_fill_count = 1
      WHERE chain_id = 4663 AND trade_uid = decode(${SCAN_FAILURE_UID.slice(2)}, 'hex')`;
    FAILED_SCAN_CHAINS.add(4663);
    try {
      await repairDefiLlamaSettlementIdentity();
    } finally {
      FAILED_SCAN_CHAINS.delete(4663);
      delete process.env.SETTLE_SCAN_START_BLOCK_4663;
    }

    const [audit] = await sql<{ expected: number | null; checked: boolean; fills: string }[]>`
      SELECT t.defillama_expected_fill_count AS expected,
             t.defillama_repair_checked_at IS NOT NULL AS checked,
             COUNT(f.*)::text AS fills
      FROM trades t LEFT JOIN defillama_fills f
        ON f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
      WHERE t.chain_id = 4663 AND t.trade_uid = decode(${SCAN_FAILURE_UID.slice(2)}, 'hex')
      GROUP BY t.defillama_expected_fill_count, t.defillama_repair_checked_at`;
    expect(audit).toEqual({ expected: null, checked: true, fills: '0' });
  });

  it('backs off rate limits without shrinking the archive window', async () => {
    process.env.SETTLE_SCAN_START_BLOCK_4663 = '100';
    BLOCK_HEADS.set(4663, 120_008n);
    const trade = apiTrade(RATE_LIMIT_UID, 60_000, 4, 100n, 1_000n);
    API_TRADES.set(`4663:${RATE_LIMIT_UID}`, [trade]);
    ORDERS.set(`4663:${RATE_LIMIT_UID}`, {
      uid: RATE_LIMIT_UID,
      owner: OWNER,
      receiver: null,
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: '100',
      buyAmount: '1000',
      appData: VOLUME_META_HASH,
      fullAppData: volumeMeta,
      creationDate: '2026-08-01T00:00:00.000Z',
      class: 'limit',
      status: 'fulfilled',
    });
    BLOCK_LOGS.set('4663:60000', [tradeLog(trade)]);
    TX_INPUTS.set(trade.txHash, settlementInput(trade));
    await insertAggregate(RATE_LIMIT_UID, 4663, 100n, 1_000n, 1);

    const callsBefore = GET_LOG_RANGES.length;
    RATE_LIMIT_ONCE_CHAINS.add(4663);
    try {
      await repairDefiLlamaSettlementIdentity();
    } finally {
      RATE_LIMIT_ONCE_CHAINS.delete(4663);
      BLOCK_HEADS.delete(4663);
      delete process.env.SETTLE_SCAN_START_BLOCK_4663;
    }

    const calls = GET_LOG_RANGES.slice(callsBefore).filter(({ chainId }) => chainId === 4663);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toEqual({ chainId: 4663, fromBlock: 100n, toBlock: 50_099n });
    expect(calls[1]).toEqual(calls[0]);

    const [audit] = await sql<{ expected: number | null; fills: string }[]>`
      SELECT t.defillama_expected_fill_count AS expected, COUNT(f.*)::text AS fills
      FROM trades t LEFT JOIN defillama_fills f
        ON f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
      WHERE t.chain_id = 4663 AND t.trade_uid = decode(${RATE_LIMIT_UID.slice(2)}, 'hex')
      GROUP BY t.defillama_expected_fill_count`;
    expect(audit).toEqual({ expected: 1, fills: '1' });
  });

  it('shrinks for explicit response-size errors that also mention capacity', async () => {
    process.env.SETTLE_SCAN_START_BLOCK_4663 = '100';
    BLOCK_HEADS.set(4663, 30_008n);
    const trade = apiTrade(OVERLAPPING_RANGE_UID, 20_000, 5, 100n, 1_000n);
    API_TRADES.set(`4663:${OVERLAPPING_RANGE_UID}`, [trade]);
    ORDERS.set(`4663:${OVERLAPPING_RANGE_UID}`, {
      uid: OVERLAPPING_RANGE_UID,
      owner: OWNER,
      receiver: null,
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: '100',
      buyAmount: '1000',
      appData: VOLUME_META_HASH,
      fullAppData: volumeMeta,
      creationDate: '2026-08-01T00:00:00.000Z',
      class: 'limit',
      status: 'fulfilled',
    });
    BLOCK_LOGS.set('4663:20000', [tradeLog(trade)]);
    TX_INPUTS.set(trade.txHash, settlementInput(trade));
    await insertAggregate(OVERLAPPING_RANGE_UID, 4663, 100n, 1_000n, 1);

    const callsBefore = GET_LOG_RANGES.length;
    OVERLAPPING_RANGE_LIMITS.set(4663, 25_000n);
    try {
      await repairDefiLlamaSettlementIdentity();
    } finally {
      OVERLAPPING_RANGE_LIMITS.delete(4663);
      BLOCK_HEADS.delete(4663);
      delete process.env.SETTLE_SCAN_START_BLOCK_4663;
    }

    const calls = GET_LOG_RANGES.slice(callsBefore).filter(({ chainId }) => chainId === 4663);
    expect(calls[0]).toEqual({ chainId: 4663, fromBlock: 100n, toBlock: 30_000n });
    expect(calls[1]).toEqual({ chainId: 4663, fromBlock: 100n, toBlock: 25_099n });

    const [audit] = await sql<{ expected: number | null; fills: string }[]>`
      SELECT t.defillama_expected_fill_count AS expected, COUNT(f.*)::text AS fills
      FROM trades t LEFT JOIN defillama_fills f
        ON f.chain_id = t.chain_id AND f.trade_uid = t.trade_uid
      WHERE t.chain_id = 4663 AND t.trade_uid = decode(${OVERLAPPING_RANGE_UID.slice(2)}, 'hex')
      GROUP BY t.defillama_expected_fill_count`;
    expect(audit).toEqual({ expected: 1, fills: '1' });
  });
});
