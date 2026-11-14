import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';

// backfillFillUserSource records where an older eth-flow fill's wallet came from (user_source),
// asking CoW for the order (injected here). Postgres is real; the orderbook is a map.
let container: StartedPostgreSqlContainer;
let sql: any;
let backfill: typeof import('../src/repair/routerTrades.js')['backfillFillUserSource'];

const FLOW = 'ba3cb449bd2b4adddbc894d8697f5170800eadec'; // canonical CoW eth-flow
const PAYER = 'a1'.repeat(20), RECV = 'b1'.repeat(20), OTHER = 'c1'.repeat(20), OWNER = 'd1'.repeat(20);
const uid = (n: number, owner = FLOW) => n.toString(16).padStart(64, '0') + owner + 'ffffffff';
type Order = { owner: string; receiver?: string | null; onchainUser?: string | null };
const ORDERS = new Map<string, Order>();
const asked: string[] = [];
const fetchOrder = async (_chainId: number, u: `0x${string}`): Promise<Order> => {
  asked.push(u);
  const o = ORDERS.get(u);
  if (!o) throw new Error('order not found (test)');
  return o;
};
let log = 0;
async function fill(u: string, wallet: string, verified = true, source: string | null = null) {
  await sql`
    INSERT INTO defillama_fills (chain_id, block_number, log_index, trade_uid, settlement_timestamp, sell_token, sell_amount, fee_verified, user_address, user_source)
    VALUES (1, 1, ${++log}, decode(${u}, 'hex'), now(), decode(${'ee'.repeat(20)}, 'hex'), 1, ${verified}, decode(${wallet}, 'hex'), ${source})`;
}
async function sources(u: string): Promise<(string | null)[]> {
  const rows = await sql`SELECT user_source FROM defillama_fills WHERE trade_uid = decode(${u}, 'hex') ORDER BY log_index`;
  return rows.map((r: { user_source: string | null }) => r.user_source);
}
async function addresses(): Promise<string[]> {
  const rows = await sql`SELECT encode(user_address, 'hex') AS a FROM defillama_fills ORDER BY log_index`;
  return rows.map((r: { a: string }) => r.a);
}

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  ({ backfillFillUserSource: backfill } = await import('../src/repair/routerTrades.js'));
  const order = (n: number, o: Omit<Order, 'owner'>) => ORDERS.set(`0x${uid(n)}`, { owner: `0x${FLOW}`, ...o });
  await fill(uid(1), PAYER); order(1, { receiver: `0x${RECV}`, onchainUser: `0x${PAYER.toUpperCase()}` }); // the payer
  await fill(uid(2), RECV); order(2, { receiver: `0x${RECV}`, onchainUser: `0x${PAYER}` }); // the receiver, CoW knows the payer
  await fill(uid(3), RECV); order(3, { receiver: `0x${RECV}` }); // the receiver, CoW has no payer
  await fill(uid(4), OTHER); order(4, { receiver: `0x${RECV}`, onchainUser: `0x${PAYER}` }); // neither: stays NULL
  await fill(uid(5), PAYER); // CoW cannot answer: stays NULL
  // A recorded payer is never downgraded, even when CoW now has no payer and its receiver is that wallet.
  await fill(uid(6), PAYER, true, 'onchain_user'); await fill(uid(6), PAYER); order(6, { receiver: `0x${PAYER}` });
  await fill(uid(7), PAYER, false); order(7, { receiver: `0x${RECV}`, onchainUser: `0x${PAYER}` }); // not verified: not asked
  await fill(uid(8, OWNER), OWNER); // a normal owner: not asked
}, 180_000);

afterAll(async () => {
  await sql?.end?.({ timeout: 5 });
  await stopPg(container);
});

describe('backfillFillUserSource', () => {
  it('asks at most `limit` orders per run', async () => {
    const before = await addresses();
    expect(await backfill(2, fetchOrder)).toEqual({ asked: 2, tagged: asked.filter((u) => ![uid(4), uid(5)].includes(u.slice(2))).length });
    expect(asked.length).toBe(2);
    expect(await addresses()).toEqual(before); // only the source is written
  });

  it('records the payer and the receiver, leaves the rest NULL, and never downgrades a payer', async () => {
    await backfill(100, fetchOrder);
    expect([await sources(uid(1)), await sources(uid(2)), await sources(uid(3)), await sources(uid(4)), await sources(uid(5))])
      .toEqual([['onchain_user'], ['receiver'], ['receiver'], [null], [null]]);
    expect(await sources(uid(6))).toEqual(['onchain_user', 'receiver']);
    expect([await sources(uid(7)), await sources(uid(8, OWNER))]).toEqual([[null], [null]]);
    expect(asked.some((u) => u.slice(2) === uid(7) || u.slice(2) === uid(8, OWNER))).toBe(false);
  });

  it('is idempotent: a tagged order is never asked again; only those CoW could not answer for are', async () => {
    asked.length = 0;
    expect(await backfill(100, fetchOrder)).toEqual({ asked: 2, tagged: 0 });
    expect(asked.map((u) => u.slice(2)).sort()).toEqual([uid(4), uid(5)].sort());
    expect(await sources(uid(6))).toEqual(['onchain_user', 'receiver']);
  });
});
