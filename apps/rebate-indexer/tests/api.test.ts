import { test, expect, afterEach, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';

// Mock the db module so buildApiServer can be imported without a real DATABASE_URL.
// The /health and rate-limit tests exercise the HTTP layer only.
vi.mock('../src/db/index.js', () => ({
  sql: Object.assign(async () => [], {
    unsafe: async () => [],
  }),
  db: {
    select: () => ({
      from: (table: unknown) => ({
        orderBy: () => ({ limit: async () => [] }),
        where: async () =>
          table === 'rebateBatches' ? [{ id: 1, status: 'proposed' }] : [{ batchId: 1 }],
      }),
    }),
  },
  schema: {
    rebateBatches: 'rebateBatches',
    rebateBatchEntries: 'rebateBatchEntries',
  },
}));

// Also mock tierer so /tier/:wallet doesn't need DB.
vi.mock('../src/tierer.js', () => ({
  getWalletStatus: async () => ({ tier: { name: 'none' }, volume_30d_usd: 0 }),
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.REBATE_INDEXER_ADMIN_TOKEN;
});

// Must import AFTER vi.mock() calls above are hoisted.
const { buildApiServer } = await import('../src/api.js');

test('429 returns statusCode 429 (not 500), and body carries statusCode field', async () => {
  app = await buildApiServer();
  // /health allows 200/min; hammer it past the limit
  for (let i = 0; i < 205; i++) {
    await app.inject({ method: 'GET', url: '/health' });
  }
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(429);
  const body = JSON.parse(res.body);
  // F1: the response body must carry statusCode 429 (not 500 or missing)
  expect(body.statusCode).toBe(429);
  expect(body.error).toBe('too many requests');
  expect(body.retryAfter).toBeDefined();
});

test('404 handler returns 404 with JSON body', async () => {
  app = await buildApiServer();
  const res = await app.inject({ method: 'GET', url: '/nonexistent-path' });
  expect(res.statusCode).toBe(404);
  expect(JSON.parse(res.body)).toMatchObject({ error: 'not found' });
});

test('/health exposes the fetcher + pipeline liveness fields', async () => {
  app = await buildApiServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.ok).toBe(true);
  // Liveness heartbeats (values null under the mocked db; the KEYS must always be
  // present): last_fetch_attempt = any fetch run (incl. backfill);
  // last_pipeline_run_at = the nightly cron tick (survives redeploys);
  // last_batcher_run_at = the last first-of-month run (the monthly Safe batcher).
  expect(body).toHaveProperty('last_fetch');
  expect(body).toHaveProperty('last_fetch_attempt');
  expect(body).toHaveProperty('last_pipeline_run_at');
  expect(body).toHaveProperty('last_batcher_run_at');
  expect(body).toHaveProperty('pending_batches');
});

test.each(['/status', '/batches', '/batches/1'])(
  '%s requires configured admin auth',
  async (url) => {
    app = await buildApiServer();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'admin auth not configured' });
  },
);

// Synthetic, zero-entropy placeholders built at runtime (never as a literal
// `Bearer <token>` string) so secret scanners don't flag them. Both are >=
// ADMIN_TOKEN_MIN_LEN (32) chars; the "wrong" one differs from the configured
// one so assertAdminAuth returns 401.
const TEST_ADMIN_TOKEN = 'x'.repeat(40);
const WRONG_ADMIN_TOKEN = 'y'.repeat(40);

test.each(['/status', '/batches', '/batches/1'])(
  '%s rejects missing and wrong admin bearer tokens',
  async (url) => {
    process.env.REBATE_INDEXER_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
    app = await buildApiServer();

    const missing = await app.inject({ method: 'GET', url });
    expect(missing.statusCode).toBe(401);
    expect(JSON.parse(missing.body)).toMatchObject({ error: 'unauthorized' });

    const wrong = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${WRONG_ADMIN_TOKEN}` },
    });
    expect(wrong.statusCode).toBe(401);
    expect(JSON.parse(wrong.body)).toMatchObject({ error: 'unauthorized' });
  },
);

test.each(['/status', '/batches', '/batches/1'])(
  '%s allows the exact configured admin bearer token',
  async (url) => {
    process.env.REBATE_INDEXER_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
    app = await buildApiServer();

    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  },
);

// CORS preflight regression guard. The signed POSTs (/partner, /ref/bind,
// /ref/codes) send content-type: application/json -> a non-safelisted header
// that forces a browser preflight. If the preflight response omits
// Allow-Methods / Allow-Headers, the browser blocks the real POST and the
// partner dashboard fails with an opaque network error. These tests lock in
// that the preflight echoes both for allowed origins (and nothing for others).
test.each(['/partner', '/ref/bind', '/ref/codes'])(
  'OPTIONS %s preflight from an allowed origin echoes Allow-Methods (POST) + Allow-Headers (content-type)',
  async (url) => {
    app = await buildApiServer();
    const res = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: 'https://swap.ophis.fi',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://swap.ophis.fi');
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('content-type');
  },
);

test('OPTIONS preflight from a DISALLOWED origin sets no CORS headers', async () => {
  app = await buildApiServer();
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/partner',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
  expect(res.headers['access-control-allow-methods']).toBeUndefined();
});
