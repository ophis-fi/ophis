import { test, expect, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readFileSync } from 'node:fs';
// Type-only: the fakes below are typed with the PRODUCER's exported types, so a
// changed producer shape fails `tsc --noEmit` here. No database is loaded.
import type { PartnerDashboard } from '../src/api.js';
import type { PartnerFeeDashboard } from '../src/partnerFees/report.js';
import { registerBusinessRoutes } from '../src/business.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/business-partner.json', import.meta.url), 'utf8'));
const PARTNER = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;
const OTHER = '0x00000000000000000000000000000000000000b2' as const;
const TOKEN = 'business-test-token-0123456789abcdef-xyz';
const ADMIN = 'admin-test-token-0123456789abcdef-uvwxyz';

const affiliate: PartnerDashboard = {
  wallet: PARTNER,
  kind: 'partner',
  rateOfNetFeePct: 12,
  activeCodes: ['northwind', 'northwind-app'],
  referredCount: 3,
  currentCycleVolumeUsd: 184250.75,
  currentCycleNetFeeUsd: 17.31,
  lifetimeReferredVolumeUsd: 2391804.5,
  estimatedCurrentCycleEarningsUsd: 2.08,
  paidToDateWeth: 0.0125,
  paidToDateUsd: 41.37,
  payoutStatus: 'scheduled',
  nextPayoutAt: '2026-12-01T02:00:00.000Z',
  referees: [
    { wallet: '0x00000000000000000000000000000000000000a1', boundAt: new Date('2026-08-03T14:05:00Z'), firstSeenAt: new Date('2026-08-03T14:05:00Z'), attribution: 'link', lifetimeVolumeUsd: 1504300.25 },
    { wallet: '0x00000000000000000000000000000000000000a2', boundAt: new Date('2026-09-19T08:40:00Z'), firstSeenAt: new Date('2026-09-17T11:12:00Z'), attribution: 'link-and-code', lifetimeVolumeUsd: 880004.25 },
    { wallet: '0x00000000000000000000000000000000000000a3', boundAt: null, firstSeenAt: new Date('2026-10-28T19:55:00Z'), attribution: 'code', lifetimeVolumeUsd: 7500 },
  ],
};
const fees = (recipient: `0x${string}`, full: boolean): PartnerFeeDashboard => ({
  recipient,
  currentCycle: full
    ? { grossFeeUsd: 96.5, partnerShareUsd: 77.2, carriedInUsd: 6.4, owedUsd: 83.6, pendingUnpricedTrades: 2 }
    : { grossFeeUsd: 0, partnerShareUsd: 0, carriedInUsd: 0, owedUsd: 0, pendingUnpricedTrades: 0 },
  lifetime: full ? { paidWeth: 0.0875, tradeCount: 412 } : { paidWeth: 0, tradeCount: 0 },
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

let app: FastifyInstance;
let asked: string[];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T09:30:00Z') });
  process.env.BUSINESS_API_TOKEN = TOKEN;
  process.env.REBATE_INDEXER_ADMIN_TOKEN = ADMIN;
  asked = [];
  app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  registerBusinessRoutes(app, {
    getPartnerDashboard: async (a) => { asked.push(a); return a === PARTNER ? affiliate : null; },
    getPartnerFeeDashboard: async (a) => fees(a, a === PARTNER),
  });
});
afterEach(async () => {
  await app.close();
  vi.useRealTimers();
  delete process.env.BUSINESS_API_TOKEN;
  delete process.env.REBATE_INDEXER_ADMIN_TOKEN;
});

const call = (wallets: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  app.inject({ method: 'POST', url: '/business/partner', headers, payload: { wallets } });

test('the answer equals the contract file exactly', async () => {
  const res = await call([PARTNER, OTHER]);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual(fixture);
  expect(JSON.parse(res.body)).toStrictEqual(JSON.parse(JSON.stringify(fixture)));
});

test('the contract file shows what the console is built against', () => {
  const [p, o] = fixture.wallets;
  expect(p.affiliate.activeCodes).toHaveLength(2);
  expect(p.affiliate.referees.map((r: { attribution: string }) => r.attribution).sort()).toEqual(['code', 'link', 'link-and-code']);
  expect(p.fees.recentBatches).toHaveLength(2);
  expect(p.affiliate.payoutStatus).toBe('scheduled');
  expect(p.affiliate.nextPayoutAt).toBe('2026-12-01T02:00:00.000Z');
  expect(o.affiliate).toBeNull();
  expect(o.fees.currentCycle.owedUsd + o.fees.lifetime.paidWeth + o.fees.lifetime.tradeCount).toBe(0);
});

test.each([
  ['unset', undefined],
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
  ['too short', ['0x1234']],
  ['not hex', [`0x${'g'.repeat(40)}`]],
  ['a duplicate', [PARTNER, PARTNER]],
  ['a duplicate in another case', [PARTNER, PARTNER.toUpperCase().replace('0X', '0x')]],
])('400 when wallets is %s', async (_name, wallets) => {
  const res = await call(wallets);
  expect(res.statusCode).toBe(400);
  expect(asked).toEqual([]);
});

test('10 wallets pass, upper case is lowered, and the order asked is kept', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => addr(10 - i));
  const res = await call(ten);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).wallets.map((w: { wallet: string }) => w.wallet)).toEqual(ten);
  const swapped = JSON.parse((await call([OTHER, PARTNER.toUpperCase().replace('0X', '0x')])).body);
  expect(swapped.wallets.map((w: { wallet: string }) => w.wallet)).toEqual([OTHER, PARTNER]);
  expect(swapped.wallets[0].affiliate).toBeNull();
  expect(swapped.wallets[1].affiliate.wallet).toBe(PARTNER);
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
