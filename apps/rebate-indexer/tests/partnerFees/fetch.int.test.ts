import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { runMigrations } from '../../src/db/migrate.js';
import { startPg, stopPg } from '../fixtures/pgContainer.js';

// testcontainers + msw feed mock: idempotent ingestion of the restricted partner-fee feed,
// positional attribution, cursor advance, and the ambiguous-mapping skip (partner-fees Phase B).

const FEED = 'http://feed.test/partner_fees';
const OPHIS = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
const PARTNER_A = '0x1111111111111111111111111111111111111111';
const PARTNER_B = '0x2222222222222222222222222222222222222222';
const BUY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const uid = (n: number) => '0x' + n.toString(16).padStart(112, '0');
const appData = (pf: unknown) => JSON.stringify({ metadata: { partnerFee: pf } });

// Ophis-only (no attribution), a registered partner (attributed), and an ambiguous mismatch.
const TRADES = [
  { blockNumber: 100, logIndex: 1, orderUid: uid(1), owner: OPHIS, sellToken: BUY, buyToken: BUY, sellAmount: '1', buyAmount: '1', protocolFeeAmounts: ['1000'], protocolFeeTokens: [BUY], protocolFeeKinds: ['volume'], fullAppData: appData([{ volumeBps: 10, recipient: OPHIS }]) },
  { blockNumber: 100, logIndex: 2, orderUid: uid(2), owner: OPHIS, sellToken: BUY, buyToken: BUY, sellAmount: '1', buyAmount: '1', protocolFeeAmounts: ['1000', '3000'], protocolFeeTokens: [BUY, BUY], protocolFeeKinds: ['volume', 'volume'], fullAppData: appData([{ volumeBps: 10, recipient: OPHIS }, { volumeBps: 30, recipient: PARTNER_A }]) },
  { blockNumber: 101, logIndex: 1, orderUid: uid(3), owner: OPHIS, sellToken: BUY, buyToken: BUY, sellAmount: '1', buyAmount: '1', protocolFeeAmounts: ['1000'], protocolFeeTokens: [BUY], protocolFeeKinds: ['volume'], fullAppData: appData([{ volumeBps: 10, recipient: OPHIS }, { volumeBps: 30, recipient: PARTNER_B }]) },
];

// Serve the 3 trades only from the genesis cursor; any advanced cursor is drained. Single page.
const server = setupServer(
  http.get(FEED, ({ request }) => {
    const url = new URL(request.url);
    const minBlock = Number(url.searchParams.get('min_block') ?? '0');
    if (minBlock === 0) return HttpResponse.json({ trades: TRADES });
    return HttpResponse.json({ trades: [] });
  }),
);

let pg: StartedPostgreSqlContainer;
async function getSql() {
  return (await import('../../src/db/index.js')).sql;
}
async function runFetch() {
  const { runPartnerFeeFetch } = await import('../../src/partnerFees/fetch.js');
  // Inject the block-timestamp fetcher so the enrichment pass never hits a real RPC.
  return runPartnerFeeFetch({ feeds: [{ chainId: 10, url: FEED }], blockTimestamp: async () => new Date('2026-05-15T00:00:00Z') });
}

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  server.listen();
  await runMigrations();
}, 120_000);

afterAll(async () => {
  server.close();
  await stopPg(pg);
});

beforeEach(async () => {
  const sql = await getSql();
  await sql`TRUNCATE partner_fee_trades, partner_fee_cursor, partner_fee_skips RESTART IDENTITY CASCADE`;
  vi.restoreAllMocks();
});

describe('partner-fee feed ingestion', () => {
  it('attributes only the non-Ophis registered partner, skips the ambiguous one', async () => {
    const sql = await getSql();
    const r = await runFetch();
    expect(r.inserted).toBe(1); // only PARTNER_A (Ophis-only yields none, PARTNER_B is a mismatch)
    expect(r.skipped).toBe(1); // PARTNER_B's trade: 2 candidates but 1 slot
    const rows = await sql<{ recipient_hex: string; fee_amount: string; fee_token_hex: string; volume_bps: number }[]>`
      SELECT encode(recipient, 'hex') AS recipient_hex, fee_amount::text AS fee_amount, encode(fee_token, 'hex') AS fee_token_hex, volume_bps
      FROM partner_fee_trades`;
    expect(rows).toHaveLength(1);
    expect(`0x${rows[0]!.recipient_hex}`).toBe(PARTNER_A.toLowerCase());
    expect(rows[0]!.fee_amount).toBe('3000');
    expect(`0x${rows[0]!.fee_token_hex}`).toBe(BUY);
    expect(rows[0]!.volume_bps).toBe(30);
    // The skip left a DURABLE identity-keyed marker (the accrual gate blocks on it).
    const skips = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM partner_fee_skips WHERE resolved_at IS NULL`;
    expect(skips[0]!.n).toBe('1');
  });

  it('re-fetching the same ambiguous settlement (cursor rewind) does NOT inflate the skip ledger', async () => {
    const sql = await getSql();
    await runFetch();
    // Rewind the cursor (crash-before-save / operator rewind) and re-drain the feed.
    await sql`UPDATE partner_fee_cursor SET next_block = 0, next_log_index = 0`;
    const r2 = await runFetch();
    expect(r2.skipped).toBe(1); // counted per run...
    const skips = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM partner_fee_skips`;
    expect(skips[0]!.n).toBe('1'); // ...but ONE durable row: identity-keyed, idempotent
    // A rewind over an already-RESOLVED skip stays resolved (accounted for once).
    await sql`UPDATE partner_fee_skips SET resolved_at = now()`;
    await sql`UPDATE partner_fee_cursor SET next_block = 0, next_log_index = 0`;
    await runFetch();
    const unresolved = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM partner_fee_skips WHERE resolved_at IS NULL`;
    expect(unresolved[0]!.n).toBe('0');
  });

  it('a feed with NO trades yet still writes an ACTIVATION cursor row (so later removal fails closed)', async () => {
    const sql = await getSql();
    const { runPartnerFeeFetch } = await import('../../src/partnerFees/fetch.js');
    const r = await runPartnerFeeFetch({
      feeds: [{ chainId: 10, url: FEED }],
      fetcher: async () => ({ trades: [] }), // live feed, zero history
      blockTimestamp: async () => new Date('2026-05-15T00:00:00Z'),
    });
    expect(r.misconfigured).toBe(false);
    const rows = await sql<{ chain_id: number }[]>`SELECT chain_id FROM partner_fee_cursor`;
    expect(rows).toHaveLength(1); // activation row despite the empty page
    // Trimming the zero-history feed from the config now fails closed.
    const r2 = await (await import('../../src/partnerFees/fetch.js')).runPartnerFeeFetch({ feeds: [], fetcher: async () => ({ trades: [] }) });
    expect(r2.misconfigured).toBe(true);
  });

  it('a PARTIALLY trimmed feed config (cursor chain missing from feeds) is MISCONFIGURED', async () => {
    const sql = await getSql();
    // The program has been active on 10 AND 130; the config now lists only 10.
    await sql`INSERT INTO partner_fee_cursor (chain_id, next_block, next_log_index) VALUES (130, 5, 0)`;
    const r = await runFetch(); // runFetch configures chain 10 only
    expect(r.misconfigured).toBe(true);
    expect(r.inserted).toBe(0); // fail-closed: no partial work that would look healthy
  });

  it('advances the cursor to just AFTER the last trade', async () => {
    const sql = await getSql();
    await runFetch();
    const [c] = await sql<{ next_block: string; next_log_index: string }[]>`
      SELECT next_block::text AS next_block, next_log_index::text AS next_log_index FROM partner_fee_cursor WHERE chain_id = 10`;
    expect(c!.next_block).toBe('101');
    expect(c!.next_log_index).toBe('2'); // last trade was (101, 1) -> resume at (101, 2)
  });

  it('is idempotent: a second run from the advanced cursor inserts nothing new', async () => {
    const sql = await getSql();
    await runFetch();
    const r2 = await runFetch();
    expect(r2.inserted).toBe(0);
    const n = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM partner_fee_trades`;
    expect(n[0]!.n).toBe('1');
  });

  it('is idempotent on a re-read of the SAME rows (ON CONFLICT DO NOTHING)', async () => {
    const sql = await getSql();
    await runFetch();
    // Rewind the cursor to genesis so the feed serves the same 3 trades again (an overlap replay).
    await sql`UPDATE partner_fee_cursor SET next_block = 0, next_log_index = 0 WHERE chain_id = 10`;
    const r2 = await runFetch();
    // The PK (trade_uid, recipient) dedupes: no duplicate row despite re-attributing.
    const n = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM partner_fee_trades`;
    expect(n[0]!.n).toBe('1');
    expect(r2.inserted).toBe(1); // it re-attributed (the ON CONFLICT is the real dedupe)
  });

  it('REFUSES to poll a chain not asserted config-fee-free (fail loud, before any DB write)', async () => {
    const { runPartnerFeeFetch } = await import('../../src/partnerFees/fetch.js');
    await expect(runPartnerFeeFetch({ feeds: [{ chainId: 8453, url: FEED }] })).rejects.toThrow(/config-fee-free/i);
  });

  it('preserves BOTH settlements of a partiallyFillable order (same uid, distinct block/log)', async () => {
    const sql = await getSql();
    const { runPartnerFeeFetch } = await import('../../src/partnerFees/fetch.js');
    const uidA = uid(42);
    // One order uid settling TWICE (block 200 log 1, then block 201 log 5), each collecting a
    // distinct partner fee. The old (trade_uid, recipient) PK would ON CONFLICT DO NOTHING the
    // second -> discard 2000. The widened PK persists both.
    const twoSettlements = [
      { blockNumber: 200, logIndex: 1, orderUid: uidA, owner: OPHIS, sellToken: BUY, buyToken: BUY, sellAmount: '1', buyAmount: '1', protocolFeeAmounts: ['1000', '3000'], protocolFeeTokens: [BUY, BUY], protocolFeeKinds: ['volume', 'volume'], fullAppData: appData([{ volumeBps: 10, recipient: OPHIS }, { volumeBps: 30, recipient: PARTNER_A }]) },
      { blockNumber: 201, logIndex: 5, orderUid: uidA, owner: OPHIS, sellToken: BUY, buyToken: BUY, sellAmount: '1', buyAmount: '1', protocolFeeAmounts: ['1000', '2000'], protocolFeeTokens: [BUY, BUY], protocolFeeKinds: ['volume', 'volume'], fullAppData: appData([{ volumeBps: 10, recipient: OPHIS }, { volumeBps: 30, recipient: PARTNER_A }]) },
    ];
    const r = await runPartnerFeeFetch({
      feeds: [{ chainId: 10, url: FEED }],
      blockTimestamp: async () => new Date('2026-05-15T00:00:00Z'),
      fetcher: async (_feed, minBlock) => (minBlock === 0n ? { trades: twoSettlements } : { trades: [] }),
    });
    expect(r.inserted).toBe(2); // BOTH settlements' fees, not one
    const rows = await sql<{ fee_amount: string; block: string }[]>`
      SELECT fee_amount::text AS fee_amount, block_number::text AS block FROM partner_fee_trades
      WHERE recipient = decode(${PARTNER_A.slice(2)}, 'hex') ORDER BY block_number`;
    expect(rows.map((x) => x.fee_amount)).toEqual(['3000', '2000']);
  });
});
