import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';
import { DECODER_ETHFLOW_OWNERS } from '../src/fetcher.js';

// The public /leaderboard must agree with /stats on WHO is a trader and on WHICH
// trades count as volume:
//
//   1. eth-flow ROUTER contracts are not people. computePublicStats already excludes
//      them from distinctTraders (see statsCount.int.test.ts); a router must likewise
//      never occupy a leaderboard rank.
//   2. `volumeTotalUsd` is displayed next to `volume30dUsd`, which comes from the
//      `wallets` matview and is Sepolia-free + fee-gated (migrations 0011, 0018). The
//      all-time figure must apply the SAME filters, differing only in the time window,
//      so total >= 30d always holds and testnet dust can never inflate the all-time
//      column.
let container: StartedPostgreSqlContainer;
let sql: any;
let getLeaderboard: typeof import('../src/leaderboard.js')['getLeaderboard'];
let getRankInfo: typeof import('../src/leaderboard.js')['getRankInfo'];

const W = (h: string) => h.replace(/^0x/, '').padStart(40, '0');
const UID = (h: string) => h.padStart(112, '0');
const HUMAN_A = '0494f503912c101bfd76b88e4f5d8a33de284d1a';
const HUMAN_B = '04981ff1f1a901b0f5221af38e7ee4aca8353a27';
// The canonical CoW eth-flow PROD router: the one that actually landed in `trades`
// via the owner-scoped API fetch and surfaced at rank 4 on the live leaderboard.
const ROUTER = 'ba3cb449bd2b4adddbc894d8697f5170800eadec';
const SEPOLIA = 11155111;

const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const OLD = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

async function ins(
  uid: string,
  chain: number,
  wallet: string,
  usd: string,
  at: string,
  feeBps: number | null,
) {
  await sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code,
      value_usd, priced_at, volume_fee_bps)
    VALUES (
      decode(${UID(uid)}, 'hex'), ${chain}, decode(${W(wallet)}, 'hex'), 1, ${at},
      decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'), 1, 1, 'ophis',
      ${usd}, ${at}, ${feeBps})`;
}

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  ({ getLeaderboard, getRankInfo } = await import('../src/leaderboard.js'));

  // HUMAN_A: one recent + one old production trade -> 30d = 100, all-time = 300.
  await ins('01', 100, HUMAN_A, '100', RECENT, null);
  await ins('02', 100, HUMAN_A, '200', OLD, null);
  // Same wallet, trades the all-time column must NOT pick up: Sepolia testnet dust
  // (excluded by 0018) and an examined-0-fee trade (excluded by the 0011 fee gate).
  await ins('03', SEPOLIA, HUMAN_A, '5000', RECENT, null);
  await ins('04', 1, HUMAN_A, '7000', RECENT, 0);
  // HUMAN_B: a single clean production trade.
  await ins('05', 1, HUMAN_B, '50', RECENT, null);
  // The router: real settled volume, but not a person.
  await ins('06', 1, ROUTER, '500', RECENT, null);

  // HUMAN_A refers HUMAN_B (bound before every seeded trade), then B adds the same
  // two dirty-trade shapes: referredVolumeUsd must count only B's clean $50, not
  // testnet dust or examined-0-fee volume (same rules as every other column).
  const BOUND = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    INSERT INTO ref_codes (code, referrer_wallet, kind, active)
    VALUES ('itest', decode(${W(HUMAN_A)}, 'hex'), 'regular', true)`;
  await sql`
    INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at)
    VALUES (decode(${W(HUMAN_B)}, 'hex'), 'itest', decode(${W(HUMAN_A)}, 'hex'), true, ${BOUND})`;
  await ins('07', SEPOLIA, HUMAN_B, '9000', RECENT, null);
  await ins('08', 1, HUMAN_B, '8000', RECENT, 0);

  await sql.unsafe('REFRESH MATERIALIZED VIEW wallets');
}, 180_000);

afterAll(async () => {
  await sql?.end?.({ timeout: 5 });
  await stopPg(container);
});

describe('getLeaderboard', () => {
  it('never ranks an eth-flow router contract', async () => {
    const board = await getLeaderboard(100);
    const routers = new Set([...DECODER_ETHFLOW_OWNERS].map((r) => r.toLowerCase()));
    for (const entry of board.entries) {
      // The API returns 0xXXXX...XXXX, so compare on the truncation of each router.
      const truncated = [...routers].map((r) => `${r.slice(0, 6)}...${r.slice(-4)}`);
      expect(truncated).not.toContain(entry.wallet);
    }
    expect(board.entries.map((e) => e.wallet)).toEqual([
      `0x${HUMAN_A.slice(0, 4)}...${HUMAN_A.slice(-4)}`,
      `0x${HUMAN_B.slice(0, 4)}...${HUMAN_B.slice(-4)}`,
    ]);
  });

  it('ranks the remaining humans contiguously from 1', async () => {
    const board = await getLeaderboard(100);
    expect(board.entries.map((e) => e.rank)).toEqual([1, 2]);
  });

  it('excludes Sepolia and examined-0-fee trades from the all-time column', async () => {
    const board = await getLeaderboard(100);
    const a = board.entries.find((e) => e.wallet.startsWith('0x0494'))!;
    expect(a.volume30dUsd).toBeCloseTo(100, 4);
    // 100 recent + 200 old. NOT 12300: the 5000 Sepolia and 7000 fee-0 rows are
    // filtered out of the 30d column and must be filtered out of all-time too.
    expect(a.volumeTotalUsd).toBeCloseTo(300, 4);
  });

  it('excludes Sepolia and examined-0-fee trades from referred volume', async () => {
    const board = await getLeaderboard(100);
    const a = board.entries.find((e) => e.wallet.startsWith('0x0494'))!;
    expect(a.affiliateCount).toBe(1);
    // B's clean $50 only. NOT 17050: the $9000 Sepolia and $8000 fee-0 referred
    // trades are display-dust exactly like they are in the volume columns.
    expect(a.referredVolumeUsd).toBeCloseTo(50, 4);
  });

  it('keeps all-time >= 30d for every ranked wallet', async () => {
    const board = await getLeaderboard(100);
    expect(board.entries.length).toBeGreaterThan(0);
    for (const entry of board.entries) {
      expect(entry.volumeTotalUsd).toBeGreaterThanOrEqual(entry.volume30dUsd);
    }
  });
});

describe('getRankInfo', () => {
  // The router's 500 is the LARGEST 30d volume in the seed set, so without the
  // exclusion it would hold position 1 and push every human down one: exactly the
  // live skew this PR fixes. getRankInfo counts positions in an independent
  // ROW_NUMBER() query, so it must be pinned separately from getLeaderboard.
  it('reports positions matching the router-free board', async () => {
    const a = await getRankInfo(`0x${HUMAN_A}`);
    const b = await getRankInfo(`0x${HUMAN_B}`);
    expect(a?.position).toBe(1); // 100 (30d) beats 50
    expect(b?.position).toBe(2);
  });

  it('gives a router volume and tier but never a position', async () => {
    const r = await getRankInfo(`0x${ROUTER}`);
    // The router IS in the wallets matview (its 30d volume is real), so tier data
    // resolves, but it occupies no rank on the board it was excluded from.
    expect(r?.volume30dUsd).toBeCloseTo(500, 4);
    expect(r?.position).toBeNull();
  });
});
