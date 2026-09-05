import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';
import { DECODER_ETHFLOW_OWNERS } from '../src/fetcher.js';

// The public /stats "distinct traders" number must count HUMANS, not eth-flow router
// contracts. A native-ETH order settles with owner = a router, and if that router
// wallet lands in `trades` (as the canonical CoW eth-flow 0xba3c… did) it must NOT be
// counted as a person — but its trade volume/count is real and MUST still be counted.
let container: StartedPostgreSqlContainer;
let sql: any;
let computePublicStats: typeof import('../src/stats.js')['computePublicStats'];
let computeDefiLlamaDay: typeof import('../src/stats.js')['computeDefiLlamaDay'];
let computeDefiLlamaDayUsers: typeof import('../src/stats.js')['computeDefiLlamaDayUsers'];

const W = (h: string) => h.replace(/^0x/, '').padStart(40, '0');
const UID = (h: string) => h.padStart(112, '0');
const HUMAN_A = '0494f503912c101bfd76b88e4f5d8a33de284d1a';
const HUMAN_B = '04981ff1f1a901b0f5221af38e7ee4aca8353a27';
const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
// Every eth-flow router (Ophis-dedicated + canonical CoW prod/barn), from the single
// source of truth — so the test excludes the FULL set, not a hardcoded subset.
const ROUTERS = [...DECODER_ETHFLOW_OWNERS];
let fillLogIndex = 0;

async function ins(uid: string, chain: number, wallet: string, usd: string, tx = uid) {
  await sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, priced_at)
    VALUES (
      decode(${UID(uid)}, 'hex'), ${chain}, decode(${W(wallet)}, 'hex'), 1, ${RECENT},
      decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'), 1, 1, 'ophis', ${usd}, ${RECENT})`;
  await sql`
    INSERT INTO defillama_fills (
      chain_id, block_number, log_index, trade_uid, transaction_hash, user_address, settlement_timestamp,
      sell_token, sell_amount, volume_fee_bps, fee_verified, value_usd, priced_at)
    VALUES (
      ${chain}, 1, ${fillLogIndex++}, decode(${UID(uid)}, 'hex'),
      decode(${tx.padStart(64, '0')}, 'hex'), decode(${W(wallet)}, 'hex'), ${RECENT},
      decode(${W('5e11')}, 'hex'), 1, NULL, true, ${usd}, ${RECENT})`;
}

// Fixed seed set: 2 humans (3 trades) + one $20 trade per router, all priced.
const HUMAN_TRADES = 3;
const HUMAN_VOLUME = 100 + 50 + 19000;
const ROUTER_VOLUME_EACH = 20;
const TOTAL_TRADES = HUMAN_TRADES + ROUTERS.length;
const TOTAL_VOLUME = HUMAN_VOLUME + ROUTER_VOLUME_EACH * ROUTERS.length;

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  ({ computePublicStats, computeDefiLlamaDay, computeDefiLlamaDayUsers } = await import('../src/stats.js'));
  await ins('01', 100, HUMAN_A, '100'); // human A, Gnosis
  await ins('02', 100, HUMAN_A, '50'); // human A again (same person, 2 trades)
  await ins('03', 1, HUMAN_B, '19000'); // human B, Ethereum
  // One trade per router on Ethereum — real settled rows that are NOT people.
  for (let i = 0; i < ROUTERS.length; i++) {
    await ins((10 + i).toString(16).padStart(2, '0'), 1, ROUTERS[i]!, String(ROUTER_VOLUME_EACH));
  }
}, 180_000);

afterAll(async () => {
  await sql?.end?.({ timeout: 5 });
  await stopPg(container);
});

describe('computePublicStats', () => {
  it('excludes EVERY eth-flow router from distinctTraders but counts their trades + volume', async () => {
    const s = await computePublicStats(sql, [1, 100]);
    expect(s.totalTrades).toBe(TOTAL_TRADES); // humans + all routers are real trades
    expect(s.totalVolumeUsd).toBeCloseTo(TOTAL_VOLUME, 4); // includes every router's volume
    expect(s.distinctTraders).toBe(2); // HUMAN_A + HUMAN_B only; no router counts
  });

  it('leaves chainsActive and avgTradeUsd unaffected by the router exclusion', async () => {
    const s = await computePublicStats(sql, [1, 100]);
    // chains counts distinct chain_id over ALL rows (routers on chain 1, humans on 1+100).
    expect(s.chainsActive).toBe(2);
    // avg is over ALL priced trades (routers included) — the exclusion is trader-count only.
    expect(s.avgTradeUsd).toBeCloseTo(TOTAL_VOLUME / TOTAL_TRADES, 2);
  });

  it('router volume still appears in the per-chain breakdown', async () => {
    const s = await computePublicStats(sql, [1, 100]);
    const eth = s.byChain.find((c) => c.chainId === 1);
    expect(eth?.trades).toBe(1 + ROUTERS.length); // human B + every router, all on Ethereum
    expect(eth?.volumeUsd).toBeCloseTo(19000 + ROUTER_VOLUME_EACH * ROUTERS.length, 4);
  });
});

describe('computeDefiLlamaDay', () => {
  it('counts verified volume but excludes unknown fees from fee and revenue totals', async () => {
    const rows = await computeDefiLlamaDay(sql, RECENT.slice(0, 10), [1, 100], [10, 130, 4663], 7500);
    expect(rows.reduce((sum, row) => sum + row.volumeUsd, 0)).toBeCloseTo(TOTAL_VOLUME, 4);
    expect(rows.reduce((sum, row) => sum + row.feesUsd, 0)).toBe(0);
    expect(rows.reduce((sum, row) => sum + row.revenueUsd, 0)).toBe(0);
    expect(rows.reduce((sum, row) => sum + row.supplySideRevenueUsd, 0)).toBe(0);
    expect(rows.reduce((sum, row) => sum + row.transactions, 0)).toBe(TOTAL_TRADES);
  });

  it('does not confuse partial fills with settlement transactions or active users', async () => {
    const uidA = UID('e1');
    const uidB = UID('e2');
    const tx = 'aa'.repeat(32);
    const metricDay = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
        settlement_timestamp, sell_token, sell_amount, volume_fee_bps, fee_verified,
        value_usd, priced_at)
      VALUES
        (10, 8, ${fillLogIndex++}, decode(${uidA}, 'hex'), decode(${tx}, 'hex'), decode(${W(HUMAN_A)}, 'hex'),
         ${metricDay}, decode(${W('5e11')}, 'hex'), 1, 1, true, 10, ${RECENT}),
        (10, 8, ${fillLogIndex++}, decode(${uidB}, 'hex'), decode(${tx}, 'hex'), decode(${W(HUMAN_A)}, 'hex'),
         ${metricDay}, decode(${W('5e11')}, 'hex'), 1, 1, true, 20, ${RECENT})
    `;
    const [optimism] = await computeDefiLlamaDay(sql, metricDay.slice(0, 10), [10], [10, 130, 4663], 7500);
    expect(optimism).toMatchObject({ trades: 2, transactions: 1, users: 1, volumeUsd: 30 });
  });

  it('deduplicates the same active wallet across chains in protocol totals', async () => {
    const metricDay = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
        settlement_timestamp, sell_token, sell_amount, volume_fee_bps,
        assessed_fee_bps, fee_verified, value_usd, priced_at)
      VALUES
        (1, 18, ${fillLogIndex++}, decode(${UID('e3')}, 'hex'), decode(${'ab'.repeat(32)}, 'hex'),
         decode(${W(HUMAN_A)}, 'hex'), ${metricDay}, decode(${W('5e11')}, 'hex'), 1, 1, 1, true, 10, ${RECENT}),
        (100, 19, ${fillLogIndex++}, decode(${UID('e4')}, 'hex'), decode(${'cd'.repeat(32)}, 'hex'),
         decode(${W(HUMAN_A)}, 'hex'), ${metricDay}, decode(${W('5e11')}, 'hex'), 1, 1, 1, true, 20, ${RECENT})
    `;
    const chains = await computeDefiLlamaDay(sql, metricDay.slice(0, 10), [1, 100], [10, 130, 4663], 7500);
    expect(chains.reduce((sum, row) => sum + row.users, 0)).toBe(2);
    expect(await computeDefiLlamaDayUsers(sql, metricDay.slice(0, 10), [1, 100])).toBe(1);
  });

  it('preserves explicit zero fees and retains the full fee on sovereign chains', async () => {
    const zeroUid = UID('f0');
    const sovereignUid = UID('f1');
    await sql`
      INSERT INTO trades (
        trade_uid, chain_id, wallet, block_number, block_timestamp,
        sell_token, buy_token, sell_amount, buy_amount, app_code,
        value_usd, priced_at, volume_fee_bps)
      VALUES
        (decode(${zeroUid}, 'hex'), 1, decode(${W(HUMAN_A)}, 'hex'), 2, ${RECENT},
         decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'), 1, 1, 'ophis', 1000, ${RECENT}, 0),
        (decode(${sovereignUid}, 'hex'), 10, decode(${W(HUMAN_A)}, 'hex'), 3, ${RECENT},
         decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'), 1, 1, 'ophis', 2000, ${RECENT}, 5)
    `;
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, settlement_timestamp,
        sell_token, sell_amount, volume_fee_bps, assessed_fee_bps, fee_verified, value_usd, priced_at)
      VALUES
        (1, 2, ${fillLogIndex++}, decode(${zeroUid}, 'hex'), ${RECENT},
         decode(${W('5e11')}, 'hex'), 1, 0, NULL, true, 1000, ${RECENT}),
        (10, 3, ${fillLogIndex++}, decode(${sovereignUid}, 'hex'), ${RECENT},
         decode(${W('5e11')}, 'hex'), 1, 5, 7.5, true, 2000, ${RECENT})
    `;
    const rows = await computeDefiLlamaDay(sql, RECENT.slice(0, 10), [1, 10], [10, 130, 4663], 7500);
    const sovereign = rows.find((row) => row.chainId === 10);
    expect(sovereign).toMatchObject({ volumeUsd: 2000, feesUsd: 1.5, revenueUsd: 1.5, supplySideRevenueUsd: 0 });

    const eth = rows.find((row) => row.chainId === 1)!;
    // The explicit 0-bps row adds volume but no fee; unknown-fee rows also add no assumed fee.
    const legacyEthVolume = 19000 + ROUTER_VOLUME_EACH * ROUTERS.length;
    expect(eth.volumeUsd).toBeCloseTo(legacyEthVolume + 1000, 4);
    expect(eth.feesUsd).toBe(0);
  });

  it('excludes unverified decoder discovery rows from all DefiLlama metrics', async () => {
    await sql`
      INSERT INTO trades (
        trade_uid, chain_id, wallet, block_number, block_timestamp,
        sell_token, buy_token, sell_amount, buy_amount, app_code,
        value_usd, priced_at, volume_fee_bps, fee_verified)
      VALUES (
        decode(${UID('f2')}, 'hex'), 100, decode(${W(HUMAN_A)}, 'hex'), 4, ${RECENT},
        decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'), 1, 1, 'ophis',
        999999, ${RECENT}, 0, false)
    `;
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, settlement_timestamp,
        sell_token, sell_amount, volume_fee_bps, fee_verified, value_usd, priced_at)
      VALUES (
        100, 4, ${fillLogIndex++}, decode(${UID('f2')}, 'hex'), ${RECENT},
        decode(${W('5e11')}, 'hex'), 1, 0, false, 999999, ${RECENT})
    `;
    const rows = await computeDefiLlamaDay(sql, RECENT.slice(0, 10), [100], [10, 130, 4663], 7500);
    const gnosis = rows.find((row) => row.chainId === 100)!;
    expect(gnosis.volumeUsd).toBe(150);
    expect(gnosis.trades).toBe(2);
  });

  it('buckets separate fills of one order by their settlement timestamps', async () => {
    const uid = UID('f3');
    const day = RECENT.slice(0, 10);
    const next = new Date(`${day}T12:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await sql`
      INSERT INTO defillama_fills (
        chain_id, block_number, log_index, trade_uid, settlement_timestamp,
        sell_token, sell_amount, volume_fee_bps, fee_verified, value_usd, priced_at)
      VALUES
        (1, 5, ${fillLogIndex++}, decode(${uid}, 'hex'), ${day + 'T23:59:59.000Z'},
         decode(${W('5e11')}, 'hex'), 1, 10, true, 10, ${RECENT}),
        (1, 6, ${fillLogIndex++}, decode(${uid}, 'hex'), ${next.toISOString()},
         decode(${W('5e11')}, 'hex'), 1, 10, true, 20, ${RECENT})
    `;
    const first = await computeDefiLlamaDay(sql, day, [1], [10, 130, 4663], 7500);
    const second = await computeDefiLlamaDay(sql, next.toISOString().slice(0, 10), [1], [10, 130, 4663], 7500);
    expect(first.find((row) => row.chainId === 1)?.volumeUsd).toBeCloseTo(
      19000 + ROUTER_VOLUME_EACH * ROUTERS.length + 1000 + 10,
      4,
    );
    expect(second).toMatchObject([{ chainId: 1, volumeUsd: 20, trades: 1 }]);
  });
});
