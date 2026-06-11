import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { eq, desc } from 'drizzle-orm';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { sql, db, schema } from './db/index.js';
import { getWalletStatus } from './tierer.js';
import { renderTierPage } from './tier-page.js';
import { logger } from './logger.js';
import { verifyPartnerAuth } from './affiliate/partnerAuth.js';
import { FEE_SHARE_BPS, type AffiliateKind } from './affiliate/rates.js';

// Bounds on the cycle window for a referrer's current-month affiliate stats.
function currentCycleWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

// Referrer's effective tier + active codes + this-cycle referred volume/count.
// Shared by GET /affiliate/:wallet (public) and POST /partner (signature-gated).
async function getReferrerStats(referrer: `0x${string}`, now: Date) {
  const buf = Buffer.from(referrer.slice(2), 'hex');
  const codes = await sql<{ code: string; kind: string; active: boolean }[]>`
    SELECT code, kind, active FROM ref_codes WHERE referrer_wallet = ${buf} ORDER BY created_at
  `;
  const isPartner = codes.some((c) => c.active && c.kind === 'partner');
  const kind: AffiliateKind = isPartner ? 'partner' : 'regular';
  const { start, end } = currentCycleWindow(now);
  const [agg] = await sql<{ referred_count: string; volume_usd: string | null }[]>`
    SELECT
      COUNT(DISTINCT r.referred_wallet)::text AS referred_count,
      COALESCE(SUM(t.value_usd), 0)::text     AS volume_usd
    FROM referrals r
    LEFT JOIN trades t
      ON t.wallet = r.referred_wallet
      AND t.block_timestamp >= ${start.toISOString()} AND t.block_timestamp < ${end.toISOString()}
      AND t.block_timestamp >= r.bound_at AND t.value_usd IS NOT NULL
    WHERE r.referrer_wallet = ${buf}
  `;
  return {
    wallet: referrer,
    kind,
    rateOfNetFeePct: FEE_SHARE_BPS[kind] / 100, // 8 or 12
    activeCodes: codes.filter((c) => c.active).map((c) => c.code),
    referredCount: agg ? parseInt(agg.referred_count, 10) : 0,
    currentCycleVolumeUsd: agg && agg.volume_usd ? parseFloat(agg.volume_usd) : 0,
  };
}

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
    const allowed = ['https://ophis.fi', 'https://www.ophis.fi', 'https://swap.ophis.fi', 'https://greg.pages.dev'];
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
    // last_fetch       = MAX(trades.fetched_at): advances only when a NEW Ophis
    //                    trade is inserted, so it is STALE during any quiet
    //                    period and is NOT a fetcher-liveness signal on its own.
    // last_fetch_attempt = MAX(tracked_wallets.last_attempt_at): stamped on EVERY
    //                    fetch run (incl. the startup backfill), so an idle-but-
    //                    healthy fetcher is distinguishable from a dead one. NOTE:
    //                    a redeploy's backfill overwrites this, so it cannot
    //                    witness the 02:00 cron tick specifically.
    // last_pipeline_run_at = MAX(pipeline_runs.ran_at): set ONLY by the nightly
    //                    cron (runPipelineSteps), never by the startup backfill —
    //                    so a redeploy can't clobber it. This is the signal that
    //                    the 02:00 UTC pipeline actually ran. NULL until the first
    //                    nightly completes after this table was created.
    // last_batcher_run_at = MAX(ran_at) over first-of-month runs: when the monthly
    //                    Safe batcher step last executed, so "did the batcher tick
    //                    on the 1st?" is answerable from /health without admin auth.
    // All are single aggregate timestamps — no wallet data exposed.
    const healthRows = await sql<{
      last_fetch: string | null;
      last_fetch_attempt: string | null;
      last_pipeline_run_at: string | null;
      last_batcher_run_at: string | null;
    }[]>`
      SELECT
        (SELECT MAX(fetched_at)::text FROM trades) AS last_fetch,
        (SELECT MAX(last_attempt_at)::text FROM tracked_wallets) AS last_fetch_attempt,
        (SELECT MAX(ran_at)::text FROM pipeline_runs) AS last_pipeline_run_at,
        (SELECT MAX(ran_at)::text FROM pipeline_runs WHERE first_of_month) AS last_batcher_run_at
    `;
    // pending_batches = in-flight (computing/proposing/proposed) — expected to be
    // transient. failed_batches = cycles that did NOT pay out (execution reverted,
    // or all recipients quarantined) and need human triage. The nightly reconciler
    // alerts via Telegram, but that is fire-and-forget; exposing failed_batches on
    // this PUBLIC, rate-permissive endpoint lets an external uptime monitor catch a
    // non-paying cycle even if the Telegram alert is dropped. Count only, no wallet
    // data. (audit 2026-06 P3)
    const batchCountRows = await sql<{ pending: string; failed: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('computing','proposing','proposed'))::text AS pending,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
      FROM rebate_batches
    `;
    const last_fetch = healthRows[0]?.last_fetch ?? null;
    const last_fetch_attempt = healthRows[0]?.last_fetch_attempt ?? null;
    const last_pipeline_run_at = healthRows[0]?.last_pipeline_run_at ?? null;
    const last_batcher_run_at = healthRows[0]?.last_batcher_run_at ?? null;
    const pending = batchCountRows[0]?.pending ?? '0';
    const failed = batchCountRows[0]?.failed ?? '0';
    return {
      ok: true,
      last_fetch,
      last_fetch_attempt,
      last_pipeline_run_at,
      last_batcher_run_at,
      pending_batches: parseInt(pending, 10),
      failed_batches: parseInt(failed, 10),
    };
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

    // Content negotiation (review item #17): a BROWSER navigating here (e.g.
    // clicking the rebate chip, which opens this URL in a new tab) sends
    // `Accept: text/html` and gets a styled page instead of raw JSON. The
    // chip's own data fetch sends `Accept: */*`, so it still receives JSON
    // unchanged — no frontend change needed.
    //
    // Vary on BOTH Origin and Accept. Accept so a shared cache keys HTML vs
    // JSON separately; Origin because the onRequest CORS hook above sets
    // `Vary: origin` (+ Access-Control-Allow-Origin) for allowed origins, and a
    // bare `reply.header('vary', 'accept')` would OVERWRITE that — risking a
    // cached response served with the wrong ACAO. Listing Origin here is inert
    // for non-CORS requests, so setting it unconditionally is safe.
    reply.header('vary', 'Origin, Accept');
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html')) {
      // Single cheap aggregate (mirrors /health) so the payout line reflects
      // the REAL batcher state and never implies a distribution that has not
      // happened yet.
      const batcherRows = await sql<{ last: string | null }[]>`
        SELECT MAX(ran_at)::text AS last FROM pipeline_runs WHERE first_of_month
      `;
      const html = renderTierPage(status, {
        nextCycleIso: nextFirstOfMonth().toISOString(),
        lastBatcherRunAt: batcherRows[0]?.last ?? null,
      });
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        )
        .send(html);
    }
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
    // Strict digits-only: parseInt('5abc',10)===5 and parseInt('0x5',10)===0
    // would otherwise coerce padded/garbage ids. Mirror the strict /tier/:wallet
    // address regex. (audit P3)
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const id = parseInt(req.params.id, 10);
    const [batch] = await db.select().from(schema.rebateBatches).where(eq(schema.rebateBatches.id, id));
    if (!batch) return reply.code(404).send({ error: 'not found' });
    const entries = await db.select().from(schema.rebateBatchEntries).where(eq(schema.rebateBatchEntries.batchId, id));
    return { batch, entries };
  });

  // ─── Affiliate / Partner program ─────────────────────────────────────────

  // Bind a referred wallet to a referral code. PUBLIC + rate-limited.
  // SIGNATURE-gated: the caller must prove control of `referredWallet` by signing
  // the bind message (same mechanism as /ref/codes) so nobody can bind a wallet
  // they don't own and steal attribution. Enforces: code must exist+active; no
  // self-referral; no CIRCULAR referrals (referred cannot be an ancestor of the
  // referrer); NET-NEW only (a wallet with prior Ophis trades is rejected — can't
  // farm existing volume); FIRST-BIND-WINS (ON CONFLICT DO NOTHING is idempotent +
  // lifetime). Also registers the wallet in tracked_wallets so the fetcher indexes
  // its future trades.
  app.post<{ Body: { referredWallet?: string; code?: string; issued?: number; signature?: string } }>('/ref/bind', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const referred = String(req.body?.referredWallet ?? '').toLowerCase();
    // Codes are canonical LOWERCASE (mint + admin-seed store lowercase). Normalize
    // here so a case-folded URL/share-link code (the frontend display-uppercases)
    // still matches the case-sensitive PK lookup AND the signed message (the client
    // signs the lowercased code). Without this every URL bind silently 400s.
    const code = String(req.body?.code ?? '').toLowerCase();
    const issued = Number(req.body?.issued);
    const signature = String(req.body?.signature ?? '');
    if (!/^0x[0-9a-f]{40}$/.test(referred)) return reply.code(400).send({ error: 'invalid referredWallet' });
    if (!/^[a-z0-9_-]{3,64}$/.test(code)) return reply.code(400).send({ error: 'invalid code' });
    if (!Number.isInteger(issued)) return reply.code(400).send({ error: 'invalid issued timestamp' });
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return reply.code(400).send({ error: 'invalid signature' });

    // Prove the caller controls `referred` before any DB work. verifyPartnerAuth
    // rebuilds `Ophis bind referral code <code>\nAddress: <referred>\nIssued: <issued>`,
    // recovers the signer, checks it equals `referred`, and enforces the replay window.
    const auth = await verifyPartnerAuth({
      action: 'bind referral code ' + code,
      address: referred,
      issued,
      signature: signature as `0x${string}`,
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    // Use the recovered, verified address so the stored referred_wallet is the
    // proven signer, not the raw body field.
    const referredBuf = Buffer.from(auth.address.slice(2), 'hex');

    return sql.begin(async (tx) => {
      // Serialize all binds with a global advisory lock so the cycle check below
      // sees a COMMITTED view. Without it two concurrent binds (A->B and B->A) both
      // read pre-commit state, both pass the cycle probe, and create a reciprocal
      // referral cycle. Binds are infrequent (one per wallet, rate-limited 20/min),
      // so global serialization is negligible. The lock auto-releases at tx end.
      await tx`SELECT pg_advisory_xact_lock(528491)`;

      const [rc] = await tx<{ referrer_hex: string; active: boolean }[]>`
        SELECT encode(referrer_wallet, 'hex') AS referrer_hex, active FROM ref_codes WHERE code = ${code}
      `;
      if (!rc || !rc.active) return reply.code(400).send({ error: 'invalid or inactive code' });
      if (`0x${rc.referrer_hex}` === auth.address) return reply.code(400).send({ error: 'cannot refer your own wallet' });

      const existing = await tx`SELECT 1 FROM referrals WHERE referred_wallet = ${referredBuf} LIMIT 1`;
      if (existing.length > 0) return { bound: true, alreadyBound: true }; // first-bind-wins, idempotent

      // Reject ALL cycles, not just direct self-referral: binding referred=X to a
      // code owned by referrer=Y is invalid if X is an ANCESTOR of Y in the referral
      // graph (walking referrer links upward from Y eventually reaches X), which
      // would close a loop. Walk ancestors of Y; if X appears, refuse.
      const referrerBuf = Buffer.from(rc.referrer_hex, 'hex'); // Y
      const cycle = await tx`
        WITH RECURSIVE ancestors AS (
          SELECT referrer_wallet FROM referrals WHERE referred_wallet = ${referrerBuf}
          UNION
          SELECT r.referrer_wallet FROM referrals r
            JOIN ancestors a ON r.referred_wallet = a.referrer_wallet
        )
        SELECT 1 FROM ancestors WHERE referrer_wallet = ${referredBuf} LIMIT 1
      `;
      if (cycle.length > 0) return reply.code(400).send({ error: 'circular referral not allowed' });

      const prior = await tx`SELECT 1 FROM trades WHERE wallet = ${referredBuf} LIMIT 1`;
      if (prior.length > 0) return reply.code(409).send({ error: 'wallet is not net-new (has prior trade history)' });

      await tx`
        INSERT INTO referrals (referred_wallet, code, referrer_wallet, net_new)
        VALUES (${referredBuf}, ${code}, decode(${rc.referrer_hex}, 'hex'), true)
        ON CONFLICT (referred_wallet) DO NOTHING
      `;
      await tx`INSERT INTO tracked_wallets (wallet) VALUES (${referredBuf}) ON CONFLICT (wallet) DO NOTHING`;
      return { bound: true, alreadyBound: false };
    });
  });

  // Resolve a referral code (frontend validation before binding). PUBLIC.
  app.get<{ Params: { code: string } }>('/ref/:code', {
    config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const code = req.params.code.toLowerCase(); // codes are canonical lowercase
    if (!/^[a-z0-9_-]{3,64}$/.test(code)) return reply.code(400).send({ error: 'invalid code' });
    const [rc] = await sql<{ kind: string; active: boolean }[]>`
      SELECT kind, active FROM ref_codes WHERE code = ${code}
    `;
    if (!rc) return { exists: false };
    return { exists: true, kind: rc.kind, active: rc.active };
  });

  // Self-serve REGULAR code creation. SIGNATURE-gated (the signer proves wallet
  // ownership, so a code can only be minted for the wallet that signed). Idempotent:
  // returns the wallet's existing active regular code if any, else mints a fresh
  // RANDOM one. Partner codes are NOT self-serve (admin-seeded only).
  app.post<{ Body: { wallet?: string; issued?: number; signature?: string } }>('/ref/codes', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const wallet = String(req.body?.wallet ?? '').toLowerCase();
    const issued = Number(req.body?.issued);
    const signature = String(req.body?.signature ?? '');
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) return reply.code(400).send({ error: 'invalid wallet address' });
    if (!Number.isInteger(issued)) return reply.code(400).send({ error: 'invalid issued timestamp' });
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return reply.code(400).send({ error: 'invalid signature' });
    const auth = await verifyPartnerAuth({ action: 'create referral code', address: wallet, issued, signature: signature as `0x${string}`, nowSec: Math.floor(Date.now() / 1000) });
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    const buf = Buffer.from(auth.address.slice(2), 'hex');
    const [existing] = await sql<{ code: string }[]>`
      SELECT code FROM ref_codes WHERE referrer_wallet = ${buf} AND kind = 'regular' AND active = true LIMIT 1
    `;
    if (existing) return { code: existing.code, kind: 'regular', created: false };
    // RANDOM, unguessable code. The existing-active-code lookup above guarantees
    // idempotency, so a non-deterministic code is safe. A 48-bit random suffix makes
    // collisions negligible; the retry loop covers the astronomically rare clash. An
    // attacker can no longer vanity-grind and pre-create a victim's code because it
    // is unpredictable (the old `oph<address[2:10]>` was only 32 address-derived bits
    // and inserted with ON CONFLICT DO NOTHING while still claiming created:true).
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = 'oph' + randomBytes(6).toString('hex'); // 48-bit random
      try {
        const inserted = await sql<{ code: string }[]>`
          INSERT INTO ref_codes (code, referrer_wallet, kind, active)
          VALUES (${candidate}, ${buf}, 'regular', true)
          ON CONFLICT (code) DO NOTHING
          RETURNING code
        `;
        if (inserted.length > 0) return { code: candidate, created: true };
        // Empty RETURNING = the random code collided on the PK (astronomically
        // rare); retry with a fresh candidate.
      } catch (err) {
        // A concurrent mint for THIS wallet won the (referrer_wallet, kind) WHERE
        // active partial unique index (not the code PK, so ON CONFLICT (code) does
        // not catch it). Return the code the other request just created.
        if ((err as { code?: string })?.code === '23505') {
          const [winner] = await sql<{ code: string }[]>`
            SELECT code FROM ref_codes WHERE referrer_wallet = ${buf} AND kind = 'regular' AND active = true LIMIT 1
          `;
          if (winner) return { code: winner.code, kind: 'regular', created: false };
        }
        throw err;
      }
    }
    return reply.code(500).send({ error: 'could not allocate a referral code, please retry' });
  });

  // A referrer's own affiliate stats (referred count, this-cycle volume, tier+rate).
  // PUBLIC + wallet-scoped: returns only aggregate performance for the queried wallet
  // (no per-referee detail, no PII). The sensitive Partner detail is sig-gated below.
  app.get<{ Params: { wallet: string } }>('/affiliate/:wallet', {
    config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const raw = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) return reply.code(400).send({ error: 'invalid wallet address' });
    reply.header('vary', 'Origin');
    return getReferrerStats(raw as `0x${string}`, new Date());
  });

  // Partner dashboard data — WHITELIST + SIGNATURE gated. POST (not GET) so the
  // signature never lands in a URL/access log. The caller must (a) be a whitelisted
  // partner (own an ACTIVE partner-kind code) and (b) prove ownership by signing the
  // partnerAuth message. One partner can never read another's data: the recovered
  // signer must equal the requested wallet.
  app.post<{ Body: { wallet?: string; issued?: number; signature?: string } }>('/partner', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const wallet = String(req.body?.wallet ?? '').toLowerCase();
    const issued = Number(req.body?.issued);
    const signature = String(req.body?.signature ?? '');
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) return reply.code(400).send({ error: 'invalid wallet address' });
    if (!Number.isInteger(issued)) return reply.code(400).send({ error: 'invalid issued timestamp' });
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return reply.code(400).send({ error: 'invalid signature' });

    const auth = await verifyPartnerAuth({ address: wallet, issued, signature: signature as `0x${string}`, nowSec: Math.floor(Date.now() / 1000) });
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });

    // Whitelist: the signer must hold an ACTIVE partner code.
    const buf = Buffer.from(auth.address.slice(2), 'hex');
    const [partner] = await sql`SELECT 1 FROM ref_codes WHERE referrer_wallet = ${buf} AND kind = 'partner' AND active = true LIMIT 1`;
    if (!partner) return reply.code(403).send({ error: 'not a whitelisted partner' });

    const stats = await getReferrerStats(auth.address, new Date());
    // Partner detail: their bound referees' addresses + each one's cycle volume.
    const referees = await sql<{ wallet_hex: string; bound_at: Date; volume_usd: string | null }[]>`
      SELECT encode(r.referred_wallet, 'hex') AS wallet_hex, r.bound_at,
             COALESCE(SUM(t.value_usd), 0)::text AS volume_usd
      FROM referrals r
      LEFT JOIN trades t ON t.wallet = r.referred_wallet AND t.block_timestamp >= r.bound_at AND t.value_usd IS NOT NULL
      WHERE r.referrer_wallet = ${buf}
      GROUP BY r.referred_wallet, r.bound_at
      ORDER BY r.bound_at DESC
      LIMIT 500
    `;
    return {
      ...stats,
      referees: referees.map((x) => ({ wallet: `0x${x.wallet_hex}`, boundAt: x.bound_at, lifetimeVolumeUsd: x.volume_usd ? parseFloat(x.volume_usd) : 0 })),
    };
  });

  // Seed / manage referral codes — ADMIN-token gated. Used to whitelist partners
  // (kind='partner') from the gitignored roster and to mint regular codes. Revoke
  // by re-posting with active=false (existing bindings stay lifetime).
  app.post<{ Body: { code?: string; referrerWallet?: string; payoutWallet?: string | null; kind?: string; active?: boolean } }>('/admin/ref-codes', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!assertAdminAuth(req, reply)) return reply;
    const code = String(req.body?.code ?? '').toLowerCase(); // codes are canonical lowercase
    const referrer = String(req.body?.referrerWallet ?? '').toLowerCase();
    const kind = String(req.body?.kind ?? '');
    const active = req.body?.active ?? true;
    if (!/^[a-z0-9_-]{3,64}$/.test(code)) return reply.code(400).send({ error: 'invalid code' });
    if (!/^0x[0-9a-f]{40}$/.test(referrer)) return reply.code(400).send({ error: 'invalid referrerWallet' });
    if (kind !== 'regular' && kind !== 'partner') return reply.code(400).send({ error: 'kind must be regular or partner' });
    // Optional payout redirect (migration 0007). Absent/null => NULL column => pay to
    // referrer_wallet. When present it is validated EXACTLY like referrerWallet and
    // stored as a Buffer; it only moves where the WETH goes, never the identity.
    const rawPayout = req.body?.payoutWallet;
    let payoutBuf: Buffer | null = null;
    if (rawPayout !== undefined && rawPayout !== null && rawPayout !== '') {
      const payout = String(rawPayout).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(payout)) return reply.code(400).send({ error: 'invalid payoutWallet' });
      payoutBuf = Buffer.from(payout.slice(2), 'hex');
    }
    await sql`
      INSERT INTO ref_codes (code, referrer_wallet, payout_wallet, kind, active)
      VALUES (${code}, decode(${referrer.slice(2)}, 'hex'), ${payoutBuf}, ${kind}, ${active})
      ON CONFLICT (code) DO UPDATE SET
        referrer_wallet = EXCLUDED.referrer_wallet,
        payout_wallet = EXCLUDED.payout_wallet,
        kind = EXCLUDED.kind,
        active = EXCLUDED.active
    `;
    return { ok: true, code, kind, active, payoutWallet: payoutBuf ? `0x${payoutBuf.toString('hex')}` : null };
  });

  // ─── Leaderboard & Ranking ───────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>('/leaderboard', {
    config: {
      rateLimit: { max: 100, timeWindow: '1 minute' }, // public endpoint
    },
  }, async (req, reply) => {
    const { getLeaderboard } = await import('./leaderboard.js');
    let limit = 100;
    if (req.query.limit) {
      const parsed = parseInt(req.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        return reply.code(400).send({ error: 'limit must be between 1 and 100' });
      }
      limit = parsed;
    }
    reply.header('vary', 'Origin');
    reply.header('cache-control', 'public, max-age=60');
    const leaderboard = await getLeaderboard(limit);
    return leaderboard;
  });

  app.get<{ Params: { wallet: string } }>('/rank/:wallet', {
    config: {
      rateLimit: { max: 100, timeWindow: '1 minute' }, // public endpoint
    },
  }, async (req, reply) => {
    const { getRankInfo } = await import('./leaderboard.js');
    const raw = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) return reply.code(400).send({ error: 'invalid wallet address' });
    reply.header('vary', 'Origin');
    const rankInfo = await getRankInfo(raw as `0x${string}`);
    if (!rankInfo) return reply.code(404).send({ error: 'wallet not found' });
    return rankInfo;
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
