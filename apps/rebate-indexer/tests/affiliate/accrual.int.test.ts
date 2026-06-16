import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from '../fixtures/pgContainer.js';

let pg: StartedPostgreSqlContainer;
let sql: any;
let buildAffiliateReferrers: (s: Date, e: Date) => Promise<any[]>;
let getReferrerStats: (w: `0x${string}`, now: Date) => Promise<any>;

const W = (h: string) => h.padStart(40, '0');
const UID = (h: string) => h.padStart(112, '0');

beforeAll(async () => {
  const { container, connectionUri } = await startPg();
  pg = container;
  process.env.DATABASE_URL = connectionUri;
  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations();
  ({ sql } = await import('../../src/db/index.js'));
  ({ buildAffiliateReferrers } = await import('../../src/affiliate/accrual.js'));
  ({ getReferrerStats } = await import('../../src/api.js'));
}, 180_000);
afterAll(async () => { await sql?.end?.(); await stopPg(pg); });

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

  it('attributes appData-tagged trades to the code owner (appData-wins, self-referral excluded, stale-code fallback)', async () => {
    const refA = W('a99a'); // owner of an ACTIVE appData code
    const refB = W('b99b'); // owner of an ACTIVE bind code + bound referees
    const refC = W('c99c'); // owner of an INACTIVE code (should earn nothing)
    const trader = W('d99d'); // unbound wallet, trades tagged with refA's code
    const bound = W('e99e'); // bound to refB; also makes one appData-tagged trade
    const stale = W('f99f'); // bound to refB; trades tagged with an INACTIVE code
    const selfOwner = W('1a2b'); // bound to refB AND owns an active code; self-tags

    await sql`INSERT INTO ref_codes (code, referrer_wallet, kind, active) VALUES ('appref1', decode(${refA},'hex'), 'regular', true)`;
    await sql`INSERT INTO ref_codes (code, referrer_wallet, kind, active) VALUES ('bind1', decode(${refB},'hex'), 'regular', true)`;
    await sql`INSERT INTO ref_codes (code, referrer_wallet, kind, active) VALUES ('dead1', decode(${refC},'hex'), 'regular', false)`;
    await sql`INSERT INTO ref_codes (code, referrer_wallet, kind, active) VALUES ('selfown', decode(${selfOwner},'hex'), 'regular', true)`;
    await sql`INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at) VALUES (decode(${bound},'hex'),'bind1',decode(${refB},'hex'),true, now() - interval '40 days')`;
    await sql`INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at) VALUES (decode(${stale},'hex'),'bind1',decode(${refB},'hex'),true, now() - interval '40 days')`;
    await sql`INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at) VALUES (decode(${selfOwner},'hex'),'bind1',decode(${refB},'hex'),true, now() - interval '40 days')`;

    const now = new Date();
    const inWindow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
    const ins = (uid: string, wallet: string, usd: string, ref: string | null) => sql`
      INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, appdata_ref_code, value_usd, priced_at)
      VALUES (decode(${UID(uid)},'hex'), 100, decode(${wallet},'hex'), 1, ${inWindow}, decode(${W('5e11')},'hex'), decode(${W('b111')},'hex'), 1, 1, 'ophis', ${ref}, ${usd}, now())`;

    await ins('a91', trader, '100000', 'appref1'); // unbound trader, tagged -> refA (direct)
    await ins('a92', bound, '200000', null); //        bound wallet, untagged -> refB (bind)
    await ins('a93', bound, '50000', 'appref1'); //     bound wallet, tagged ACTIVE -> refA (appData-wins, NOT refB)
    await ins('a94', refA, '1000000', 'appref1'); //    refA's OWN wallet, tagged refA's code -> self-referral, NO credit
    await ins('a95', stale, '30000', 'dead1'); //       bound wallet, tagged INACTIVE code -> falls back to refB (bind)
    await ins('a96', selfOwner, '40000', 'selfown'); //  bound wallet self-tagging its OWN active code -> appData rejects (self-referral), so it must FALL BACK to refB's bind (not vanish)

    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const refs = await buildAffiliateReferrers(start, end);

    const a = refs.find((r) => r.referrer_wallet === `0x${refA}`);
    const b = refs.find((r) => r.referrer_wallet === `0x${refB}`);
    // refA: appData volume only (trader 100k + bound 50k); self-referral 1M excluded.
    expect(a).toBeTruthy();
    expect(a.volumeByChain.get(100)).toBe(150000);
    // refB: bind volume only — untagged 200k + stale-inactive-code fallback 30k +
    // selfOwner self-code fallback 40k = 270k. The active-non-self appData-tagged
    // trade is appData-wins -> NOT double-counted here.
    expect(b).toBeTruthy();
    expect(b.volumeByChain.get(100)).toBe(270000);
    // The INACTIVE code owner earns nothing (no active code, no bind).
    expect(refs.find((r) => r.referrer_wallet === `0x${refC}`)).toBeFalsy();
    // The self-tagging owner earns nothing for its own self-tagged trade (it went
    // to its bind referrer refB, not to itself).
    expect(refs.find((r) => r.referrer_wallet === `0x${selfOwner}`)).toBeFalsy();
  });

  it('getReferrerStats: current-cycle volume = bind + appData, no double-count, referredCount bind-based', async () => {
    const refS = W('5ec0'); // referrer owning an active code used for BOTH bind + appData
    const boundW = W('b0c0'); // bound to refS; makes an untagged AND a tagged trade
    const pureW = W('9c0c'); // unbound; trades tagged with refS's code (appData only)

    await sql`INSERT INTO ref_codes (code, referrer_wallet, kind, active) VALUES ('scode', decode(${refS},'hex'), 'regular', true)`;
    await sql`INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new, bound_at) VALUES (decode(${boundW},'hex'),'scode',decode(${refS},'hex'),true, now() - interval '40 days')`;
    // Current-cycle trades (now()), so currentCycleWindow(new Date()) includes them.
    const insNow = (uid: string, wallet: string, usd: string, ref: string | null) => sql`
      INSERT INTO trades (trade_uid, chain_id, wallet, block_number, block_timestamp, sell_token, buy_token, sell_amount, buy_amount, app_code, appdata_ref_code, value_usd, priced_at)
      VALUES (decode(${UID(uid)},'hex'), 100, decode(${wallet},'hex'), 1, now(), decode(${W('5e11')},'hex'), decode(${W('b111')},'hex'), 1, 1, 'ophis', ${ref}, ${usd}, now())`;
    await insNow('5a1', boundW, '100000', null); //  bound, untagged -> bind
    await insNow('5a2', boundW, '40000', 'scode'); // bound, tagged active (owner refS <> trader) -> appData ONLY (excluded from bind)
    await insNow('5a3', pureW, '25000', 'scode'); //  unbound, tagged -> appData

    const stats = await getReferrerStats(`0x${refS}`, new Date());
    expect(stats.kind).toBe('regular');
    // bind 100k + appData (40k + 25k) = 165k. The bound+tagged 40k trade is counted
    // ONCE (appData), not also in bind -> a double-count would show 205k.
    expect(stats.currentCycleVolumeUsd).toBe(165000);
    // referredCount stays bind-based: only boundW is a bound referee (pureW is appData-only).
    expect(stats.referredCount).toBe(1);
  });
});
