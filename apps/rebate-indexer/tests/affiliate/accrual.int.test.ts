import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let pg: StartedPostgreSqlContainer;
let sql: any;
let buildAffiliateReferrers: (s: Date, e: Date) => Promise<any[]>;

const W = (h: string) => h.padStart(40, '0');
const UID = (h: string) => h.padStart(112, '0');

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations();
  ({ sql } = await import('../../src/db/index.js'));
  ({ buildAffiliateReferrers } = await import('../../src/affiliate/accrual.js'));
}, 180_000);
afterAll(async () => { await sql?.end?.(); await pg?.stop(); });

describe('buildAffiliateReferrers — integration (catches the Date-param 500)', () => {
  it('aggregates referred volume by chain, post-bound_at, with correct tier', async () => {
    const referrer = W('a11ce');
    const partner = W('b0b');
    const referred1 = W('c1');
    const referred2 = W('c2'); // partner's referee
    // codes
    await sql`INSERT INTO ref_codes (code, referrer_wallet, kind, active) VALUES ('reg1', decode(${referrer},'hex'), 'regular', true)`;
    await sql`INSERT INTO ref_codes (code, referrer_wallet, kind, active) VALUES ('par1', decode(${partner},'hex'), 'partner', true)`;
    // referrals bound a month ago
    await sql`INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at) VALUES (decode(${referred1},'hex'),'reg1',decode(${referrer},'hex'),true, now() - interval '40 days')`;
    await sql`INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at) VALUES (decode(${referred2},'hex'),'par1',decode(${partner},'hex'),true, now() - interval '40 days')`;
    // trades in the window
    const insTrade = (uid: string, wallet: string, chain: number, usd: string, ts: string) => sql`
      INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, priced_at)
      VALUES (decode(${UID(uid)},'hex'), ${chain}, decode(${wallet},'hex'), 1, ${ts}, decode(${W('5e11')},'hex'), decode(${W('b111')},'hex'), 1, 1, 'ophis', ${usd}, now())`;
    const now = new Date();
    const inWindow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
    const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString();
    await insTrade('d1', referred1, 100, '500000', inWindow);   // hosted, in window
    await insTrade('d2', referred1, 10, '300000', inWindow);    // OP, in window
    await insTrade('d3', referred1, 100, '999', before);        // out of window -> excluded
    await insTrade('d4', referred2, 100, '5000000', inWindow);  // partner referee

    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const refs = await buildAffiliateReferrers(start, end);

    const reg = refs.find((r) => r.referrer_wallet === `0x${referrer}`);
    const par = refs.find((r) => r.referrer_wallet === `0x${partner}`);
    expect(reg).toBeTruthy();
    expect(reg.kind).toBe('regular');
    expect(reg.volumeByChain.get(100)).toBe(500000); // out-of-window 999 excluded
    expect(reg.volumeByChain.get(10)).toBe(300000);
    // No payout redirect seeded for the regular referrer => null (pay to identity).
    expect(reg.payoutWallet).toBeNull();
    expect(par).toBeTruthy();
    expect(par.kind).toBe('partner');
    expect(par.volumeByChain.get(100)).toBe(5000000);
    expect(par.payoutWallet).toBeNull();
  });

  it('threads payout_wallet (migration 0007): redirect set => payoutWallet, null => null', async () => {
    const referrer = W('d00d');
    const referred = W('e11e');
    const payout = W('fa11ee');
    await sql`INSERT INTO ref_codes (code, referrer_wallet, payout_wallet, kind, active)
      VALUES ('pay1', decode(${referrer},'hex'), decode(${payout},'hex'), 'partner', true)`;
    await sql`INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at)
      VALUES (decode(${referred},'hex'),'pay1',decode(${referrer},'hex'),true, now() - interval '40 days')`;
    const now = new Date();
    const inWindow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
    await sql`INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, value_usd, priced_at)
      VALUES (decode(${UID('f1')},'hex'), 100, decode(${referred},'hex'), 1, ${inWindow}, decode(${W('5e11')},'hex'), decode(${W('b111')},'hex'), 1, 1, 'ophis', '123456', now())`;

    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const refs = await buildAffiliateReferrers(start, end);
    const r = refs.find((x) => x.referrer_wallet === `0x${referrer}`);
    expect(r).toBeTruthy();
    // referrer_wallet stays the identity; payoutWallet carries the redirect.
    expect(r.referrer_wallet).toBe(`0x${referrer}`);
    expect(r.payoutWallet).toBe(`0x${payout}`);
  });
});
