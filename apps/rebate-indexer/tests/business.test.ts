import { test, expect, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readFileSync } from 'node:fs';
// Type-only: the fake below is typed with the PRODUCER's exported type, so a
// changed producer shape fails `tsc --noEmit` here. No database is loaded.
import type { PartnerBreakdown, PartnerFeeDashboard, PartnerTraders } from '../src/partnerFees/report.js';
import { registerBusinessRoutes } from '../src/business.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/business-partner.json', import.meta.url), 'utf8'));
const PARTNER = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;
const OTHER = '0x00000000000000000000000000000000000000b2' as const;
const TOKEN = 'business-test-token-0123456789abcdef-xyz';
const ADMIN = 'admin-test-token-0123456789abcdef-uvwxyz';

const fees = (recipient: `0x${string}`, full: boolean): PartnerFeeDashboard => ({
  recipient,
  currentCycle: full
    ? { grossFeeUsd: 96.5, partnerShareUsd: 77.2, carriedInUsd: 6.4, owedUsd: 83.6, pendingUnpricedTrades: 2 }
    : { grossFeeUsd: 0, partnerShareUsd: 0, carriedInUsd: 0, owedUsd: 0, pendingUnpricedTrades: 0 },
  lifetime: full ? { paidWeth: 0.0625, tradeCount: 412 } : { paidWeth: 0, tradeCount: 0 },
  recentBatches: full
    ? [
        { cycleMonth: '2026-10', status: 'paid', owedUsd: 212.4, owedWeth: 0.0625, carriedUsd: 0 },
        { cycleMonth: '2026-09', status: 'carried', owedUsd: 0, owedWeth: 0, carriedUsd: 6.4 },
      ]
    : [],
  nextPayoutAt: '2026-12-01T02:00:00.000Z',
  minPayoutUsd: 25,
  partnerShareBps: 8000,
});

const traders = (full: boolean): PartnerTraders => ({
  wallets: full
    ? [
        { wallet: '0x00000000000000000000000000000000000000c1', trades: 227, volumeUsd: 251000.25, unpriced: 0 },
        { wallet: '0x00000000000000000000000000000000000000c2', trades: 181, volumeUsd: 118400.5, unpriced: 1 },
        { wallet: '0x00000000000000000000000000000000000000c3', trades: 1, volumeUsd: 0, unpriced: 1 },
      ]
    : [],
  unknown: full ? { trades: 3, volumeUsd: 4250, unpriced: 0 } : { trades: 0, volumeUsd: 0, unpriced: 0 },
  totals: full ? { walletCount: 3, trades: 412, volumeUsd: 373650.75, unpriced: 2 } : { walletCount: 0, trades: 0, volumeUsd: 0, unpriced: 0 },
});

const flow = (trades: number, volumeUsd: number, shareUsd: number, unpriced: number) => ({ trades, volumeUsd, shareUsd, unpriced });
const breakdown = (full: boolean): PartnerBreakdown => (full
  ? {
      daily: ([
        ['2026-08-20', 14, 12500.4, 10.0003, 0], ['2026-09-02', 22, 18250, 14.6, 0], ['2026-09-15', 31, 27400.25, 21.9202, 0], ['2026-09-28', 18, 15020, 12.016, 0],
        ['2026-10-05', 40, 36880.5, 29.5044, 0], ['2026-10-11', 9, 8100, 6.48, 0], ['2026-10-19', 52, 48210.75, 38.5686, 0], ['2026-10-26', 27, 22950, 18.36, 0],
        ['2026-11-02', 35, 31500.2, 25.2002, 0], ['2026-11-07', 12, 10900, 8.72, 1], ['2026-11-11', 1, 0, 0, 1],
      ] as const).map(([day, trades, volumeUsd, shareUsd, unpriced]) => ({ day, ...flow(trades, volumeUsd, shareUsd, unpriced) })),
      byChain: [{ chainId: 10, ...flow(300, 280000.5, 224.0004, 1) }, { chainId: 130, ...flow(112, 93650.25, 74.9202, 1) }],
      byToken: [
        { chainId: 10, token: '0x4200000000000000000000000000000000000006', trades: 180, shareUsd: 150.0004, unpriced: 0 },
        { chainId: 130, token: '0x4200000000000000000000000000000000000006', trades: 112, shareUsd: 74.9202, unpriced: 1 },
        { chainId: 10, token: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', trades: 120, shareUsd: 74, unpriced: 1 },
      ],
      payouts: [{ date: '2026-11-03', weth: 0.0625, chainId: 100, txHash: `0x${'9e'.repeat(32)}`, status: 'executed' }],
    }
  : { daily: [], byChain: [], byToken: [], payouts: [] });

let app: FastifyInstance;
let asked: string[];
let askedTraders: string[];
let askedBreakdown: [string, string][];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T09:30:00Z') });
  process.env.BUSINESS_API_TOKEN = TOKEN;
  process.env.REBATE_INDEXER_ADMIN_TOKEN = ADMIN;
  asked = [];
  askedTraders = [];
  askedBreakdown = [];
  app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  registerBusinessRoutes(app, {
    getPartnerFeeDashboard: async (a) => (asked.push(a), fees(a, a === PARTNER)),
    getPartnerTraders: async (a) => (askedTraders.push(a), traders(a === PARTNER)),
    getPartnerBreakdown: async (a, at) => (askedBreakdown.push([a, at!.toISOString()]), breakdown(a === PARTNER)),
  });
});
afterEach(async () => {
  await app.close();
  vi.useRealTimers();
  delete process.env.BUSINESS_API_TOKEN;
  delete process.env.REBATE_INDEXER_ADMIN_TOKEN;
  delete process.env.CONTRACT_WALLET_AUTH_CHAINS;
});

const call = (wallets: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, contract: unknown = {}) =>
  app.inject({ method: 'POST', url: '/business/partner', headers, payload: { wallets, contract } });

test('the answer equals the contract file exactly', async () => {
  const res = await call([PARTNER, OTHER]);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual(fixture);
  expect(JSON.parse(res.body)).toStrictEqual(JSON.parse(JSON.stringify(fixture)));
  expect([asked, askedTraders]).toEqual([[PARTNER, OTHER], [PARTNER, OTHER]]);
  // The breakdown's 90 days end at the same time as the answer's asOf.
  expect(askedBreakdown).toEqual([[PARTNER, fixture.asOf], [OTHER, fixture.asOf]]);
});

test('the contract file shows what the console is built against: the partner-fee dashboard, the traders and the breakdown of each wallet, and nothing else', () => {
  const [p, o] = fixture.wallets;
  // No referral dashboard: the console's partners get no referral share (retail POST /partner keeps it).
  expect(fixture.wallets.map((w: object) => Object.keys(w))).toEqual([['wallet', 'fees', 'traders', 'breakdown'], ['wallet', 'fees', 'traders', 'breakdown']]);
  expect(p.fees.recentBatches).toHaveLength(2);
  // The traders count the same rows as the lifetime trade count: every trade that carried the partner's fee.
  expect(p.traders.totals.trades).toBe(p.fees.lifetime.tradeCount);
  // Every wallet of it is listed, so the wallets and the trades of no known wallet add up to the totals.
  for (const k of ['trades', 'volumeUsd', 'unpriced']) expect(p.traders.wallets.reduce((s: number, w: Record<string, number>) => s + w[k]!, p.traders.unknown[k])).toBe(p.traders.totals[k]);
  expect(o.fees.currentCycle.owedUsd + o.fees.lifetime.paidWeth + o.fees.lifetime.tradeCount + o.traders.totals.walletCount).toBe(0);
  // The breakdown counts the same trades: by chain every trade, by token every trade and the same share; the paid payouts make the WETH paid to date.
  const b = p.breakdown;
  const sum = (rows: Record<string, number>[], k: string) => Math.round(rows.reduce((s, r) => s + r[k]!, 0) * 1e4) / 1e4;
  for (const k of ['trades', 'volumeUsd', 'unpriced']) expect(sum(b.byChain, k)).toBe(p.traders.totals[k]);
  for (const k of ['trades', 'shareUsd', 'unpriced']) expect(sum(b.byToken, k)).toBe(sum(b.byChain, k));
  expect(sum(b.payouts.filter((x: { status: string }) => x.status === 'executed'), 'weth')).toBe(p.fees.lifetime.paidWeth);
  // The 90 days end on asOf's day, oldest first, one row per day; a day of only trades not priced yet has volume 0 and says so.
  const days = b.daily.map((d: { day: string }) => d.day);
  expect([days, days[0] >= '2026-08-15', days.at(-1) <= fixture.asOf.slice(0, 10)]).toEqual([[...new Set(days)].sort(), true, true]);
  expect(b.daily.some((d: Record<string, number>) => d.trades === d.unpriced && d.volumeUsd === 0)).toBe(true);
  expect(Object.values(o.breakdown).flat()).toEqual([]);
});

test.each([
  ['unset', undefined],
  ['empty', ''],
  ['shorter than 32 characters', 'x'.repeat(31)],
  ['equal to the admin token', ADMIN],
])('off (404 for every caller) when the token is %s', async (_name, value) => {
  if (value === undefined) delete process.env.BUSINESS_API_TOKEN; else process.env.BUSINESS_API_TOKEN = value;
  for (const bearer of [value ?? '', TOKEN, ADMIN]) {
    const res = await call([PARTNER], { authorization: `Bearer ${bearer}` });
    expect(res.statusCode).toBe(404);
  }
  expect(asked).toEqual([]);
});

test('a 32-character token is on', async () => {
  process.env.BUSINESS_API_TOKEN = 'y'.repeat(32);
  expect((await call([PARTNER], { authorization: `Bearer ${'y'.repeat(32)}` })).statusCode).toBe(200);
});

test.each([
  ['missing', {}],
  ['wrong', { authorization: `Bearer ${TOKEN.slice(0, -1)}Q` }],
  ['a prefix of the token', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
  ['the admin token', { authorization: `Bearer ${ADMIN}` }],
  ['not a bearer', { authorization: TOKEN }],
  ['under another scheme', { authorization: `Digest ${TOKEN}` }],
])('401 when the bearer is %s', async (_name, headers) => {
  const res = await call([PARTNER], headers as Record<string, string>);
  expect(res.statusCode).toBe(401);
  expect(asked).toEqual([]);
});

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
test.each([
  ['not an array', PARTNER],
  ['missing', undefined],
  ['empty', []],
  ['11 entries', Array.from({ length: 11 }, (_, i) => addr(i + 1))],
  ['not a string', [42]],
  ['a nested list', [[PARTNER]]],
  ['an object', [{ wallet: PARTNER }]],
  ['too short', ['0x1234']],
  ['not hex', [`0x${'g'.repeat(40)}`]],
  ['a duplicate', [PARTNER, PARTNER]],
  ['a duplicate in another case', [PARTNER, PARTNER.toUpperCase().replace('0X', '0x')]],
])('400 when wallets is %s', async (_name, wallets) => {
  const res = await call(wallets);
  expect(res.statusCode).toBe(400);
  expect(asked).toEqual([]);
});

test.each([['a list', [PARTNER]], ['a string', PARTNER], ['null', null]])('400 when the body is %s, and 413 above 1 MB', async (_name, payload) => {
  const post = (body: string) => app.inject({ method: 'POST', url: '/business/partner', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: body });
  expect((await post(JSON.stringify(payload))).statusCode).toBe(400);
  expect((await post(JSON.stringify({ wallets: [PARTNER], contract: {}, pad: 'x'.repeat(1_100_000) }))).statusCode).toBe(413);
  expect(asked).toEqual([]);
});

test('10 wallets pass, upper case is lowered, and the order asked is kept', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => addr(10 - i));
  const res = await call(ten);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).wallets.map((w: { wallet: string }) => w.wallet)).toEqual(ten);
  const swapped = JSON.parse((await call([OTHER, PARTNER.toUpperCase().replace('0X', '0x')])).body);
  expect(swapped.wallets.map((w: { wallet: string; fees: { recipient: string } }) => [w.wallet, w.fees.recipient])).toEqual([[OTHER, OTHER], [PARTNER, PARTNER]]);
  expect(askedTraders.slice(-2)).toEqual([OTHER, PARTNER]);
});

// A contract wallet (a Safe) is controlled per chain: the same address on another chain can have other owners. POST
// /partner pins each contract wallet to ONE chain (CONTRACT_WALLET_AUTH_CHAINS); this route keeps that rule for the
// wallets the console proved by a contract signature. A wallet proved by its key is chain-independent, as there.
test('a contract wallet is read only when the console proved it on its pinned chain; else it gets no figures', async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const figures = async (contract: unknown) => JSON.parse((await call([PARTNER, OTHER], auth, contract)).body).wallets;
  const refused = { wallet: PARTNER, fees: null, traders: null, breakdown: null };
  // No pinned chain at all: refused, and nothing is read for it. The wallet proved by its key is served.
  expect(await figures({ [PARTNER]: [8453] })).toEqual([refused, fixture.wallets[1]]);
  expect([asked, askedTraders, askedBreakdown.map(([w]) => w)]).toEqual([[OTHER], [OTHER], [OTHER]]);
  process.env.CONTRACT_WALLET_AUTH_CHAINS = JSON.stringify({ [PARTNER]: 10 });
  expect(await figures({ [PARTNER]: [8453, 1] })).toEqual([refused, fixture.wallets[1]]); // proved on other chains only
  expect(await figures({ [PARTNER]: [8453, 10] })).toEqual(fixture.wallets); // proved on the pinned chain
  expect(await figures({})).toEqual(fixture.wallets); // proved by its key
  process.env.CONTRACT_WALLET_AUTH_CHAINS = 'not json';
  expect(await figures({ [PARTNER]: [10] })).toEqual([refused, fixture.wallets[1]]);
  process.env.CONTRACT_WALLET_AUTH_CHAINS = JSON.stringify({ [PARTNER]: '10' });
  expect(await figures({ [PARTNER]: [10] })).toEqual([refused, fixture.wallets[1]]);
});

test.each([
  ['missing', undefined],
  ['a list', [PARTNER]],
  ['about a wallet that is not asked', { [OTHER]: [10] }],
  ['in upper case', { [PARTNER.toUpperCase().replace('0X', '0x')]: [10] }],
  ['without a chain', { [PARTNER]: [] }],
  ['with a chain that is no id', { [PARTNER]: ['10'] }],
  ['with a chain below 1', { [PARTNER]: [0] }],
  ['with 11 chains', { [PARTNER]: Array.from({ length: 11 }, (_, i) => i + 1) }],
  ['no list of chains', { [PARTNER]: 10 }],
])('400 when contract is %s', async (_name, contract) => {
  const res = await app.inject({ method: 'POST', url: '/business/partner', headers: { authorization: `Bearer ${TOKEN}` }, payload: { wallets: [PARTNER], contract } });
  expect(res.statusCode).toBe(400);
  expect(asked).toEqual([]);
});

test('rate limit: 120 a minute', async () => {
  for (let i = 0; i < 120; i++) expect((await call([OTHER])).statusCode).toBe(200);
  expect((await call([OTHER])).statusCode).toBe(429);
});

test('one log line per call: the number of wallets, never the token', async () => {
  const { logger } = await import('../src/logger.js');
  const spy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  await call([PARTNER, OTHER]);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(spy.mock.calls)).toContain('"wallets":2');
  expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
  spy.mockRestore();
});
