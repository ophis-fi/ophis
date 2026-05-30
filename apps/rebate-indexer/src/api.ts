import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { eq, desc } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
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

// Trust X-Forwarded-For ONLY when the immediate TCP peer is one of:
//   - loopback (127.0.0.0/8, ::1) — local dev / same-container
//   - Docker bridge / overlay networks (172.16.0.0/12, covers the default
//     172.17-23/16 ranges that Docker and Compose assign) — production compose
//     stack where Caddy reaches the indexer at a 172.x.x.x peer address
//   - Tailscale (100.64.0.0/10) — operator SSH-tunnel reach path
//
// All other sources have their XFF header ignored. This means a public
// attacker hitting :8080 directly (bypassing Caddy, which compose exposes
// via `ports: 8080:8080`) cannot spoof X-Forwarded-For to manipulate
// req.ip and escape the per-IP rate-limit bucket.
//
// The 172.16.0.0/12 range is RFC 1918 private; in a non-Docker deploy it
// is inert because no public peer will originate from that range.
function isTrustedProxyPeer(addr: string): boolean {
  if (!addr) return false;
  // Loopback IPv4 + IPv6
  if (addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.')) return true;
  // IPv4-mapped IPv6 ::ffff:127.x
  if (addr.startsWith('::ffff:127.')) return true;
  if (isIP(addr) !== 4) return addr.startsWith('::ffff:') ? isTrustedProxyPeer(addr.slice(7)) : false;
  const [o0, o1] = addr.split('.').map(Number);
  // 172.16.0.0/12 — Docker bridge / compose networks
  if (o0 === 172 && o1 !== undefined && o1 >= 16 && o1 <= 31) return true;
  // 100.64.0.0/10 — Tailscale CGNAT range
  if (o0 === 100 && o1 !== undefined && o1 >= 64 && o1 <= 127) return true;
  return false;
}

export async function buildApiServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // The indexer sits behind Caddy in the prod compose stack. Without
    // trustProxy, req.ip is the Caddy peer IP (172.x.x.x on Docker bridge)
    // and the per-route rate-limit configs collapse into ONE shared bucket.
    // isTrustedProxyPeer() whitelists loopback + Docker bridge + Tailscale
    // so Fastify reads the real client IP from X-Forwarded-For — but only
    // when the TCP peer is actually one of those trusted ranges. Public
    // attackers hitting :8080 directly cannot spoof XFF.
    trustProxy: isTrustedProxyPeer,
  });

  // Rate-limiting: 100 requests per minute per IP across all public endpoints.
  // Admin endpoints are inherently harder to brute-force (constant-time token
  // compare) but still benefit from request-rate caps to limit log noise.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,  // 429 normally, 403 if ban triggers
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

  app.get('/health', {
    config: {
      rateLimit: { max: 200, timeWindow: '1 minute' }, // permissive — uptime monitors hit this continuously
    },
  }, async () => {
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

  app.get('/status', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' }, // stricter — admin endpoint
    },
  }, async (req, reply) => {
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

  app.get<{ Params: { wallet: string } }>('/tier/:wallet', {
    config: {
      rateLimit: { max: 100, timeWindow: '1 minute' }, // public — matches global default, explicit for CodeQL
    },
  }, async (req, reply) => {
    const raw = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) return reply.code(400).send({ error: 'invalid wallet address' });
    // Register the wallet so the fetcher backfills its Ophis trades on the next
    // run. Cheap idempotent upsert, no outbound calls — the heavy CoW fetching
    // happens in runFetcher, not on this request path (keeps /tier fast + no
    // amplification DoS surface).
    await sql`
      INSERT INTO tracked_wallets (wallet) VALUES (decode(${raw.slice(2)}, 'hex'))
      ON CONFLICT (wallet) DO NOTHING
    `;
    const status = await getWalletStatus(raw as `0x${string}`);
    return status;
  });

  app.get('/batches', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' }, // stricter — admin endpoint
    },
  }, async (req, reply) => {
    // Admin-only — exposes the entire rebate ledger (every cycle's pool,
    // safe-proposal hash, finalized tx, status). Pre-auth this was a
    // CRITICAL public-deanon + competitor-intel leak.
    if (!assertAdminAuth(req, reply)) return reply;
    const rows = await db.select().from(schema.rebateBatches).orderBy(desc(schema.rebateBatches.id)).limit(100);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/batches/:id', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' }, // stricter — admin endpoint
    },
  }, async (req, reply) => {
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

  // Rate-limit 404s too — otherwise an attacker hitting random paths
  // bypasses the limiter entirely (CodeQL js/missing-rate-limiting).
  app.setNotFoundHandler(
    { preHandler: app.rateLimit({ max: 100, timeWindow: '1 minute' }) },
    async (_req, reply) => reply.code(404).send({ error: 'not found' })
  );

  return app;
}

function nextFirstOfMonth(): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}

export async function startApi(): Promise<FastifyInstance> {
  const ADMIN_TOKEN_MIN_LEN = 32;
  const token = process.env.REBATE_INDEXER_ADMIN_TOKEN;
  if (!token) {
    throw new Error('REBATE_INDEXER_ADMIN_TOKEN must be set');
  }
  if (token.length < ADMIN_TOKEN_MIN_LEN) {
    throw new Error(
      `REBATE_INDEXER_ADMIN_TOKEN must be at least ${ADMIN_TOKEN_MIN_LEN} chars (got ${token.length})`
    );
  }
  // Length-based check is sufficient when paired with format awareness.
  // A 32-char hex token gives 128 bits of entropy (random). A 32-char
  // base64url token gives ~192 bits. Both are far above brute-force risk
  // at our rate-limit cap (30/min on admin endpoints = ~16 million years
  // for 128 bits).
  //
  // We don't try to detect the format because operators may use either;
  // just enforce minimum length and rely on the operator to generate
  // from a cryptographic RNG (e.g., `openssl rand -hex 32` or
  // `openssl rand -base64 24`). The prior unique-char heuristic
  // (>= 16 distinct chars) was a false positive for valid hex tokens
  // from `openssl rand -hex 32`: hex uses only 0-9a-f (16 possible chars)
  // so a legitimately random token could trip the guard.

  const app = await buildApiServer();
  const port = parseInt(process.env.API_PORT ?? '8080', 10);
  await app.listen({ host: '0.0.0.0', port });
  logger.info({ port }, 'api listening');
  return app;
}
