import { test, expect, afterEach, beforeEach, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';

// Capture the LAST tagged-template `sql\`...\`` call so we can assert the upsert
// shape + the bound payout_wallet param without a real Postgres. The mock is a
// function (tagged template) with an `unsafe` helper, matching db/index.ts.
type SqlCall = { strings: readonly string[]; values: unknown[] };
let lastSql: SqlCall | null = null;
const sqlMock = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    lastSql = { strings: Array.from(strings), values };
    return [] as unknown[];
  },
  { unsafe: async () => [] },
);

vi.mock('../../src/db/index.js', () => ({
  sql: sqlMock,
  db: { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => [] }), where: async () => [] }) }) },
  schema: {},
}));
vi.mock('../../src/tierer.js', () => ({
  getWalletStatus: async () => ({ tier: { name: 'none' }, volume_30d_usd: 0 }),
}));

const { buildApiServer } = await import('../../src/api.js');

// Synthetic admin token (>= 32 chars), never written as a literal Bearer string.
const ADMIN = 'z'.repeat(40);
const REFERRER = '0xAAaAAaAaaAaAaAaaAAAaAAaAAaaaAaAaAAaaAAAa'; // mixed-case 0x40hex
const PAYOUT = '0xBbBBbBBBbBbbbbBBbBBBbBBBbbBBbbBbBbBBbBbB';

let app: FastifyInstance | undefined;

beforeEach(() => {
  lastSql = null;
  process.env.REBATE_INDEXER_ADMIN_TOKEN = ADMIN;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.REBATE_INDEXER_ADMIN_TOKEN;
});

function authPost(body: unknown) {
  return app!.inject({
    method: 'POST',
    url: '/admin/ref-codes',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

test('POST /admin/ref-codes is admin-gated (503 when unconfigured, 401 wrong token)', async () => {
  delete process.env.REBATE_INDEXER_ADMIN_TOKEN;
  app = await buildApiServer();
  const noauth = await app.inject({
    method: 'POST',
    url: '/admin/ref-codes',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  expect(noauth.statusCode).toBe(503);

  await app.close();
  process.env.REBATE_INDEXER_ADMIN_TOKEN = ADMIN;
  app = await buildApiServer();
  const wrong = await app.inject({
    method: 'POST',
    url: '/admin/ref-codes',
    headers: { authorization: `Bearer ${'q'.repeat(40)}`, 'content-type': 'application/json' },
    payload: '{}',
  });
  expect(wrong.statusCode).toBe(401);
});

test('upserts with a valid payoutWallet — stored lowercased as a Buffer, UPSERT shape', async () => {
  app = await buildApiServer();
  const res = await authPost({ code: 'partner1', referrerWallet: REFERRER, payoutWallet: PAYOUT, kind: 'partner' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body).toMatchObject({ ok: true, code: 'partner1', kind: 'partner', active: true });
  // Returned payout wallet is the lowercased 0x40hex.
  expect(body.payoutWallet).toBe(PAYOUT.toLowerCase());

  // The INSERT is an UPSERT on the code PK that updates every column from EXCLUDED.
  const text = lastSql!.strings.join('?');
  expect(text).toContain('INSERT INTO ref_codes');
  expect(text).toContain('payout_wallet');
  expect(text).toContain('ON CONFLICT (code) DO UPDATE SET');
  expect(text).toContain('referrer_wallet = EXCLUDED.referrer_wallet');
  expect(text).toContain('payout_wallet = EXCLUDED.payout_wallet');
  expect(text).toContain('kind = EXCLUDED.kind');
  expect(text).toContain('active = EXCLUDED.active');
  // The bound payout param is a Buffer of the lowercased 20-byte address.
  const payoutBuf = lastSql!.values.find((v) => Buffer.isBuffer(v) && (v as Buffer).length === 20) as Buffer | undefined;
  expect(payoutBuf).toBeInstanceOf(Buffer);
  expect(`0x${payoutBuf!.toString('hex')}`).toBe(PAYOUT.toLowerCase());
});

test('stores NULL payout_wallet when payoutWallet is absent (backward-compatible)', async () => {
  app = await buildApiServer();
  const res = await authPost({ code: 'regular1', referrerWallet: REFERRER, kind: 'regular' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).payoutWallet).toBeNull();
  // The payout_wallet bound value is null (only the 20-byte referrer Buffer is present).
  expect(lastSql!.values).toContain(null);
});

test('treats empty-string and explicit null payoutWallet as NULL (not an error)', async () => {
  app = await buildApiServer();
  const cases: Array<{ code: string; payoutWallet: '' | null }> = [
    { code: 'empty_str', payoutWallet: '' },
    { code: 'explicit_null', payoutWallet: null },
  ];
  for (const { code, payoutWallet } of cases) {
    const res = await authPost({ code, referrerWallet: REFERRER, kind: 'regular', payoutWallet });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).payoutWallet).toBeNull();
  }
});

test('rejects a malformed payoutWallet with 400 (does not touch the DB)', async () => {
  app = await buildApiServer();
  lastSql = null;
  const res = await authPost({ code: 'bad1', referrerWallet: REFERRER, kind: 'partner', payoutWallet: '0x1234' });
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid payoutWallet' });
  expect(lastSql).toBeNull(); // validation rejects BEFORE the insert
});

test('still rejects a malformed referrerWallet (unchanged)', async () => {
  app = await buildApiServer();
  const res = await authPost({ code: 'bad2', referrerWallet: '0xnothex', kind: 'partner', payoutWallet: PAYOUT });
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid referrerWallet' });
});
