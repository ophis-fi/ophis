import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';

// repairRouterTrades re-attributes trades mis-stored with wallet = an eth-flow
// router to the order's receiver, and removes the routers from BOTH fetch queues
// (tracked_wallets and defillama_backfill_wallets - a router stuck in the latter
// holds the /defillama readiness gate closed forever once the fetcher stops
// processing routers as owners). The CoW orderbook is mocked per-uid; Postgres is
// real (testcontainer), so the SQL predicates and BYTEA round-trips are exercised.

// uid (0x-prefixed, 112 hex) -> mocked order. Populated per scenario in beforeAll.
const ORDERS = new Map<string, { owner: string; receiver: string | null | undefined }>();

vi.mock('../src/cow/client.js', () => ({
  // fetcher.ts (imported for DECODER_ETHFLOW_OWNERS) statically imports these
  // three names; the repair itself calls only getOrder.
  listTrades: vi.fn(async () => []),
  SUPPORTED_CHAIN_IDS: [1, 100],
  nativePrice: vi.fn(async () => 1),
  getOrder: vi.fn(async (_chainId: number, uid: string) => {
    const o = ORDERS.get(uid);
    if (!o) throw new Error('order not found (mock)');
    return {
      uid,
      owner: o.owner,
      receiver: o.receiver,
      sellToken: `0x${'11'.repeat(20)}`,
      buyToken: `0x${'22'.repeat(20)}`,
      sellAmount: '1',
      buyAmount: '1',
      appData: `0x${'00'.repeat(32)}`,
      creationDate: '2026-08-01T00:00:00.000Z',
    };
  }),
}));

let container: StartedPostgreSqlContainer;
let sql: any;
let repairRouterTrades: typeof import('../src/repair/routerTrades.js')['repairRouterTrades'];

const W = (h: string) => h.replace(/^0x/, '').padStart(40, '0');
const UID = (h: string) => h.padStart(112, '0');
const PROD_ROUTER = 'ba3cb449bd2b4adddbc894d8697f5170800eadec'; // canonical CoW eth-flow prod
const BARN_ROUTER = 'b37add6ac288bd3825a901cba6ec65a89f31b8cc'; // canonical CoW eth-flow barn
const HUMAN_X = 'aaaa00000000000000000000000000000000aaaa';
const HUMAN_Y = 'bbbb00000000000000000000000000000000bbbb';
const AT = '2026-08-01T12:00:00.000Z';

async function insTrade(uid: string, wallet: string) {
  await sql`
    INSERT INTO trades (
      trade_uid, chain_id, wallet, block_number, block_timestamp,
      sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, priced_at)
    VALUES (
      decode(${UID(uid)}, 'hex'), 1, decode(${W(wallet)}, 'hex'), 1, ${AT},
      decode(${W('5e11')}, 'hex'), decode(${W('b111')}, 'hex'), 1, 1, 'ophis', 10, ${AT})`;
}

async function walletOf(uid: string): Promise<string> {
  const [row] = await sql<{ w: string }[]>`
    SELECT encode(wallet, 'hex') AS w FROM trades WHERE trade_uid = decode(${UID(uid)}, 'hex')`;
  return row!.w;
}

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  ({ repairRouterTrades } = await import('../src/repair/routerTrades.js'));

  // u1: the repairable case. Receiver deliberately CHECKSUM-cased to pin the
  // lowercase normalization (attributeOrder lowercases the same way).
  await insTrade('01', PROD_ROUTER);
  await sql`
    INSERT INTO defillama_fills (
      chain_id, block_number, log_index, trade_uid, transaction_hash, user_address,
      settlement_timestamp, sell_token, sell_amount, buy_token, buy_amount,
      volume_fee_bps, assessed_fee_bps, fee_verified, value_usd, priced_at)
    VALUES (
      1, 1, 1, decode(${UID('01')}, 'hex'), decode(${'11'.repeat(32)}, 'hex'),
      decode(${PROD_ROUTER}, 'hex'), ${AT}, decode(${W('5e11')}, 'hex'), 1,
      decode(${W('b111')}, 'hex'), 1, 1, 1, true, 10, ${AT})`;
  ORDERS.set(`0x${UID('01')}`, { owner: `0x${PROD_ROUTER}`, receiver: `0x${HUMAN_X.toUpperCase()}` });
  // u2: receiver is ANOTHER router -> never re-attribute to a router.
  await insTrade('02', PROD_ROUTER);
  ORDERS.set(`0x${UID('02')}`, { owner: `0x${PROD_ROUTER}`, receiver: `0x${BARN_ROUTER}` });
  // u3: no receiver on the order -> skip, never guess.
  await insTrade('03', PROD_ROUTER);
  ORDERS.set(`0x${UID('03')}`, { owner: `0x${PROD_ROUTER}`, receiver: null });
  // u4: order fetch fails (not in the mock map) -> skip, retry next run.
  await insTrade('04', PROD_ROUTER);
  // u5: CoW reports a different owner than the stored wallet -> not this failure
  // mode, skip.
  await insTrade('05', PROD_ROUTER);
  ORDERS.set(`0x${UID('05')}`, { owner: `0x${HUMAN_Y}`, receiver: `0x${HUMAN_X}` });
  // u6: zero-address receiver -> skip (would credit the burn address).
  await insTrade('06', PROD_ROUTER);
  ORDERS.set(`0x${UID('06')}`, { owner: `0x${PROD_ROUTER}`, receiver: `0x${'00'.repeat(20)}` });
  // u7: an ordinary human trade the repair must never scan or touch.
  await insTrade('07', HUMAN_Y);
  // u8: repairable on its face (owner matches, receiver usable), but it already
  // backs a reward ticket. The ticket's assignment_signature signs the WALLET and
  // qualifying_trade_uid is UNIQUE, so re-attributing the trade would strand the
  // ticket AND poison the reward scheduler (reserveTicket would hit the UNIQUE
  // constraint on the same deterministic candidate every run). Must be skipped.
  await insTrade('08', PROD_ROUTER);
  ORDERS.set(`0x${UID('08')}`, { owner: `0x${PROD_ROUTER}`, receiver: `0x${HUMAN_X}` });
  await sql`
    INSERT INTO trade_reward_tickets (
      wallet, ticket_id, amount_usdg, qualifying_trade_uid, qualifying_chain_id,
      qualifying_value_usd, assignment_signature, signer_epoch)
    VALUES (
      decode(${PROD_ROUTER}, 'hex'), 1, 1000000, decode(${UID('08')}, 'hex'), 1,
      100, decode(${'ab'.repeat(65)}, 'hex'), 1)`;

  // Queues: router + human in both tables; only the router rows may be deleted.
  await sql`INSERT INTO tracked_wallets (wallet) VALUES
    (decode(${PROD_ROUTER}, 'hex')), (decode(${HUMAN_Y}, 'hex'))`;
  await sql`INSERT INTO defillama_backfill_wallets (wallet) VALUES
    (decode(${PROD_ROUTER}, 'hex')), (decode(${HUMAN_Y}, 'hex'))`;
}, 180_000);

afterAll(async () => {
  await sql?.end?.({ timeout: 5 });
  await stopPg(container);
});

describe('repairRouterTrades', () => {
  it('re-attributes only the repairable row and cleans the router out of both queues', async () => {
    const result = await repairRouterTrades();
    expect(result).toEqual({ scanned: 7, repaired: 1, skipped: 6, dequeued: 2 });

    // u1 now belongs to the real trader, lowercased.
    expect(await walletOf('01')).toBe(HUMAN_X);
    const [fill] = await sql<{ w: string }[]>`
      SELECT encode(user_address, 'hex') AS w FROM defillama_fills
      WHERE chain_id = 1 AND trade_uid = decode(${UID('01')}, 'hex')`;
    expect(fill!.w).toBe(HUMAN_X);
    // Every guarded case is untouched, including the ticketed trade u8.
    for (const uid of ['02', '03', '04', '05', '06', '08']) {
      expect(await walletOf(uid)).toBe(PROD_ROUTER);
    }
    // The ticket row itself is untouched (operator decision, never automatic).
    const [ticket] = await sql<{ w: string }[]>`
      SELECT encode(wallet, 'hex') AS w FROM trade_reward_tickets
      WHERE qualifying_trade_uid = decode(${UID('08')}, 'hex')`;
    expect(ticket!.w).toBe(PROD_ROUTER);
    // The human row was never in scope.
    expect(await walletOf('07')).toBe(HUMAN_Y);

    // Router gone from both queues; the human survives in both. Membership, not
    // exact equality: migrations seed tracked_wallets with production wallets.
    const tracked = (await sql<{ w: string }[]>`
      SELECT encode(wallet, 'hex') AS w FROM tracked_wallets`).map((r: { w: string }) => r.w);
    expect(tracked).not.toContain(PROD_ROUTER);
    expect(tracked).toContain(HUMAN_Y);
    const backfill = (await sql<{ w: string }[]>`
      SELECT encode(wallet, 'hex') AS w FROM defillama_backfill_wallets`).map((r: { w: string }) => r.w);
    expect(backfill).not.toContain(PROD_ROUTER);
    expect(backfill).toContain(HUMAN_Y);
  });

  it('is idempotent: a second run repairs nothing and dequeues nothing', async () => {
    const again = await repairRouterTrades();
    // The 6 guarded rows are re-scanned (still router-walleted) and re-skipped;
    // nothing changes and the queue deletes match no rows.
    expect(again).toEqual({ scanned: 6, repaired: 0, skipped: 6, dequeued: 0 });
    expect(await walletOf('01')).toBe(HUMAN_X);
  });
});
