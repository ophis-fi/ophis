import { test, expect, afterEach, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';

// Mock the db module so buildApiServer can be imported without a real DATABASE_URL.
// The /health and rate-limit tests exercise the HTTP layer only.
vi.mock('../src/db/index.js', () => ({
  sql: Object.assign(
    async () => [],
    {
      unsafe: async () => [],
    }
  ),
  db: {
    select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => [] }), where: async () => [] }) }),
  },
  schema: {},
}));

// Also mock tierer so /tier/:wallet doesn't need DB.
vi.mock('../src/tierer.js', () => ({
  getWalletStatus: async () => ({ tier: { name: 'none' }, volume_30d_usd: 0 }),
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
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
