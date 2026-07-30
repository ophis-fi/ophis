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

const W = (h: string) => h.replace(/^0x/, '').padStart(40, '0');
const UID = (h: string) => h.padStart(112, '0');
const HUMAN_A = '0494f503912c101bfd76b88e4f5d8a33de284d1a';
const HUMAN_B = '04981ff1f1a901b0f5221af38e7ee4aca8353a27';
const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
// Every eth-flow router (Ophis-dedicated + canonical CoW prod/barn), from the single
// source of truth — so the test excludes the FULL set, not a hardcoded subset.
const ROUTERS = [...DECODER_ETHFLOW_OWNERS];

async function ins(uid: string, chain: number, wallet: string, usd: string) {
  await sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, priced_at)
    VALUES (
      decode(${UID(uid)}, 'hex'), ${chain}, decode(${W(wallet)}, 'hex'), 1, ${RECENT},
      decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'), 1, 1, 'ophis', ${usd}, ${RECENT})`;
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
  ({ computePublicStats } = await import('../src/stats.js'));
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
