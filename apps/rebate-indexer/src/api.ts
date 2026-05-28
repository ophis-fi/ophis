import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { eq, desc } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { sql, db, schema } from './db/index.js';
import { getWalletStatus } from './tierer.js';
import { logger } from './logger.js';

/**
 * Constant-time bearer-token check for admin-only endpoints.
 *
 * `/batches`, `/batches/:id`, and `/status` expose the full rebate ledger
 * + per-wallet entries + operational tempo — pre-2026-05-21 these were
 * unauthenticated at `rebates.ophis.fi`, meaning anyone on the internet
 * could enumerate every Ophis user's wallet, tier, volume, and exact
 * rebate payout. Public deanonymization + competitive-intelligence +
 * phishing target list, all in one.
 *
 * Now: gated behind `Authorization: Bearer ${REBATE_INDEXER_ADMIN_TOKEN}`.
 * The env var is required at process start (fail-closed: if unset,
 * EVERY admin request returns 503 — we'd rather have a broken admin
 * dashboard than a leaking ledger).
 *
 * `/tier/:wallet` and `/health` remain public; `/tier` is wallet-scoped
 * (only returns the requester's own tier) and `/health` is just an
 * uptime ping.
 */
function assertAdminAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = process.env.REBATE_INDEXER_ADMIN_TOKEN;
  if (!expected) {
    reply.code(503).send({ error: 'admin auth not configured' });
    return false;
  }
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  const presented = header.slice('Bearer '.length);
  // Constant-time compare to avoid timing-side-channel token recovery.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export async function buildApiServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });                              // we use pino directly

  // Rate-limiting: 100 requests per minute per IP across all public endpoints.
  // Admin endpoints are inherently harder to brute-force (constant-time token
  // compare) but still benefit from request-rate caps to limit log noise.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      error: 'too many requests',
      retryAfter: context.after,
    }),
  });

  // CORS — the swap page (ophis.fi + *.pages.dev) calls /tier directly.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const allowed = ['https://ophis.fi', 'https://www.ophis.fi', 'https://greg.pages.dev', 'https://ophis.pages.dev'];
    if (origin && allowed.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
  });
  app.options('*', async (_req, reply) => reply.code(204).send());

  app.get('/health', async () => {
    const healthRows = await sql<{ last_fetch: string | null }[]>`
      SELECT MAX(fetched_at)::text AS last_fetch FROM trades
    `;
    const pendingRows = await sql<{ pending: string }[]>`
      SELECT COUNT(*)::text AS pending FROM rebate_batches WHERE status IN ('computing','proposed')
    `;
    const last_fetch = healthRows[0]?.last_fetch ?? null;
    const pending = pendingRows[0]?.pending ?? '0';
    return { ok: true, last_fetch, pending_batches: parseInt(pending, 10) };
  });

  app.get('/status', async (req, reply) => {
    // Admin-only — exposes total wallets + 30d volume + next cycle.
    // Operationally useful for the team dashboard, but a competitive-
    // intelligence and front-runner timing signal if public.
    if (!assertAdminAuth(req, reply)) return reply;
    const lastRows = await sql<{ cycle_month: string; status: string; pool_weth_wei: string }[]>`
      SELECT cycle_month::text, status, pool_weth_wei::text
      FROM rebate_batches ORDER BY id DESC LIMIT 1
    `;
    const walletsRows = await sql<{ total_wallets: string }[]>`SELECT COUNT(*)::text AS total_wallets FROM wallets`;
    const volumeRows = await sql<{ total_volume: string | null }[]>`SELECT COALESCE(SUM(volume_30d_usd)::text, '0') AS total_volume FROM wallets`;
    const total_wallets = walletsRows[0]?.total_wallets ?? '0';
    const total_volume = volumeRows[0]?.total_volume ?? '0';
    return {
      ok: true,
      last_batch: lastRows[0] ?? null,
      total_wallets: parseInt(total_wallets, 10),
      total_volume_30d_usd: total_volume,
      next_batch_cycle: nextFirstOfMonth().toISOString(),
    };
  });

  app.get<{ Params: { wallet: string } }>('/tier/:wallet', async (req, reply) => {
    const raw = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) return reply.code(400).send({ error: 'invalid wallet address' });
    const status = await getWalletStatus(raw as `0x${string}`);
    return status;
  });

  app.get('/batches', async (req, reply) => {
    // Admin-only — exposes the entire rebate ledger (every cycle's pool,
    // safe-proposal hash, finalized tx, status). Pre-auth this was a
    // CRITICAL public-deanon + competitor-intel leak.
    if (!assertAdminAuth(req, reply)) return reply;
    const rows = await db.select().from(schema.rebateBatches).orderBy(desc(schema.rebateBatches.id)).limit(100);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/batches/:id', async (req, reply) => {
    // Admin-only — exposes per-wallet entries (every recipient's address,
    // tier, rebate_pct, and exact wei payout for that cycle). Pre-auth
    // this was a phishing target list + full user deanonymization.
    if (!assertAdminAuth(req, reply)) return reply;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' });
    const [batch] = await db.select().from(schema.rebateBatches).where(eq(schema.rebateBatches.id, id));
    if (!batch) return reply.code(404).send({ error: 'not found' });
    const entries = await db.select().from(schema.rebateBatchEntries).where(eq(schema.rebateBatchEntries.batchId, id));
    return { batch, entries };
  });

  return app;
}

function nextFirstOfMonth(): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}

export async function startApi(): Promise<FastifyInstance> {
  const app = await buildApiServer();
  const port = parseInt(process.env.API_PORT ?? '8080', 10);
  await app.listen({ host: '0.0.0.0', port });
  logger.info({ port }, 'api listening');
  return app;
}
