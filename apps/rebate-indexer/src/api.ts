import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { eq, desc } from 'drizzle-orm';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { sql, db, schema } from './db/index.js';
import { getWalletStatus } from './tierer.js';
import { renderTierPage } from './tier-page.js';
import { renderStatsPage, PRODUCTION_CHAIN_IDS, EXECUTION_FACTS, type PublicStats } from './stats-page.js';
import { getIntegratorEarnings } from './earnings.js';
import { logger } from './logger.js';
import { verifyPartnerAuth } from './affiliate/partnerAuth.js';
import {
  FEE_SHARE_BPS,
  GROSS_FEE_BPS,
  OPTIMISM_CHAIN_ID,
  SOVEREIGN_CHAIN_IDS,
  keepFractionBps,
  estimateEarningsFromNetFeeUsd,
  type AffiliateKind,
} from './affiliate/rates.js';

// Bounds on the cycle window for a referrer's current-month affiliate stats.
function currentCycleWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

// Referrer's effective tier + active codes + this-cycle referred volume/count.
// Shared by GET /affiliate/:wallet (public) and POST /partner (signature-gated).
export async function getReferrerStats(referrer: `0x${string}`, now: Date) {
  const buf = Buffer.from(referrer.slice(2), 'hex');
  const codes = await sql<{ code: string; kind: string; active: boolean }[]>`
    SELECT code, kind, active FROM ref_codes WHERE referrer_wallet = ${buf} ORDER BY created_at
  `;
  const isPartner = codes.some((c) => c.active && c.kind === 'partner');
  const kind: AffiliateKind = isPartner ? 'partner' : 'regular';
  const { start, end } = currentCycleWindow(now);
  // Referred-volume figures. Regular affiliates only ever display the
  // current-cycle figure on the public, rate-limited /affiliate path, so for
  // them the cycle window stays in the JOIN and the query scans only this
  // cycle's trades. Partners display lifetime referred volume, so for them the
  // JOIN widens to every post-bound trade and the cycle figure becomes a FILTER.
  // Branching on kind keeps the common regular path off a full referee-history
  // scan on every profile refresh.
  const [agg] = isPartner
    ? await sql<{ referred_count: string; cycle_volume_usd: string | null; cycle_net_weighted: string | null; lifetime_volume_usd: string | null }[]>`
        SELECT
          COUNT(DISTINCT r.referred_wallet)::text AS referred_count,
          COALESCE(SUM(t.value_usd) FILTER (
            WHERE t.block_timestamp >= ${start.toISOString()} AND t.block_timestamp < ${end.toISOString()}
          ), 0)::text AS cycle_volume_usd,
          -- Cycle NET fee = SUM(value * actual bps * keepFraction(chain)) so the
          -- estimate matches the per-trade, per-chain payout: sovereign chains
          -- (OP, Unichain) keep 100%, hosted 75% (NULL bps -> retail default, like accrual).
          COALESCE(SUM(t.value_usd * COALESCE(t.volume_fee_bps, ${GROSS_FEE_BPS})
            * (CASE WHEN t.chain_id = ANY(${[...SOVEREIGN_CHAIN_IDS]}) THEN ${keepFractionBps(OPTIMISM_CHAIN_ID)}::int ELSE ${keepFractionBps(1)}::int END)) FILTER (
            WHERE t.block_timestamp >= ${start.toISOString()} AND t.block_timestamp < ${end.toISOString()}
          ), 0)::text AS cycle_net_weighted,
          COALESCE(SUM(t.value_usd), 0)::text AS lifetime_volume_usd
        FROM referrals r
        LEFT JOIN trades t
          ON t.wallet = r.referred_wallet
          AND t.block_timestamp >= r.bound_at AND t.value_usd IS NOT NULL
          -- Exclude explicit 0-fee trades (no settled Ophis fee): they earn nothing
          -- in accrual (grossBps>0 filter), so they must not inflate displayed volume
          -- or consume the regular cap here. NULL (-> retail) and positive rates stay.
          AND t.volume_fee_bps IS DISTINCT FROM 0
          -- Production chains only: mirror of accrual's Sepolia exclusion.
          AND t.chain_id <> 11155111
          -- appData-wins (mirror of accrual): exclude trades attributed via an
          -- ACTIVE code owned by someone other than the trader, so bind volume
          -- here + appData volume below are disjoint (no double-count). The
          -- LEFT JOIN still preserves the referral row, so referredCount is intact.
          AND NOT (t.appdata_ref_code IS NOT NULL AND EXISTS (
            SELECT 1 FROM ref_codes rc2 WHERE rc2.code = t.appdata_ref_code AND rc2.active AND rc2.referrer_wallet <> t.wallet
          ))
        WHERE r.referrer_wallet = ${buf}
      `
    : await sql<{ referred_count: string; cycle_volume_usd: string | null; cycle_net_weighted: string | null; lifetime_volume_usd: string | null }[]>`
        SELECT
          COUNT(DISTINCT r.referred_wallet)::text AS referred_count,
          COALESCE(SUM(t.value_usd), 0)::text AS cycle_volume_usd,
          COALESCE(SUM(t.value_usd * COALESCE(t.volume_fee_bps, ${GROSS_FEE_BPS})
            * (CASE WHEN t.chain_id = ANY(${[...SOVEREIGN_CHAIN_IDS]}) THEN ${keepFractionBps(OPTIMISM_CHAIN_ID)}::int ELSE ${keepFractionBps(1)}::int END)), 0)::text AS cycle_net_weighted,
          '0'::text AS lifetime_volume_usd
        FROM referrals r
        LEFT JOIN trades t
          ON t.wallet = r.referred_wallet
          AND t.block_timestamp >= ${start.toISOString()} AND t.block_timestamp < ${end.toISOString()}
          AND t.block_timestamp >= r.bound_at AND t.value_usd IS NOT NULL
          AND t.volume_fee_bps IS DISTINCT FROM 0 -- exclude 0-fee trades (see partner branch)
          AND t.chain_id <> 11155111 -- production chains only (mirror of accrual)
          -- appData-wins (mirror of accrual): see the partner branch above.
          AND NOT (t.appdata_ref_code IS NOT NULL AND EXISTS (
            SELECT 1 FROM ref_codes rc2 WHERE rc2.code = t.appdata_ref_code AND rc2.active AND rc2.referrer_wallet <> t.wallet
          ))
        WHERE r.referrer_wallet = ${buf}
      `;

  // appData-attributed volume for THIS referrer (mirrors accrual's appData path):
  // trades carrying one of this referrer's ACTIVE codes, owner != referrer (self-
  // referral excluded). Disjoint from the bind agg above (which now excludes these
  // trades), so summing the two does NOT double-count, and the displayed volume
  // matches what the monthly payout actually accrues. referredCount stays bind-
  // based (an appData tag credits volume; it does not create a bound referee).
  const [appdataAgg] = await sql<{ cycle_volume_usd: string; cycle_net_weighted: string; lifetime_volume_usd: string }[]>`
    SELECT
      COALESCE(SUM(t.value_usd) FILTER (
        WHERE t.block_timestamp >= ${start.toISOString()} AND t.block_timestamp < ${end.toISOString()}
      ), 0)::text AS cycle_volume_usd,
      COALESCE(SUM(t.value_usd * t.volume_fee_bps
        * (CASE WHEN t.chain_id = ANY(${[...SOVEREIGN_CHAIN_IDS]}) THEN ${keepFractionBps(OPTIMISM_CHAIN_ID)}::int ELSE ${keepFractionBps(1)}::int END)) FILTER (
        WHERE t.block_timestamp >= ${start.toISOString()} AND t.block_timestamp < ${end.toISOString()}
      ), 0)::text AS cycle_net_weighted,
      COALESCE(SUM(t.value_usd), 0)::text AS lifetime_volume_usd
    FROM trades t
    JOIN ref_codes rc ON rc.code = t.appdata_ref_code AND rc.active
    WHERE rc.referrer_wallet = ${buf}
      AND rc.referrer_wallet <> t.wallet
      AND t.value_usd IS NOT NULL
      -- appData arm requires a CONFIRMED fee (> 0), mirroring accrual's appData fee gate:
      -- it is the attacker-controllable forge surface, so NULL (surplus/PI / unconfirmed)
      -- is excluded here, unlike the bind arms above which keep NULL -> retail. Display
      -- therefore matches the monthly payout exactly. (COALESCE on the rate is now dead
      -- since NULL is excluded.)
      AND t.volume_fee_bps > 0
      AND t.chain_id <> 11155111 -- production chains only (mirror of accrual)
  `;

  const bindCycle = agg && agg.cycle_volume_usd ? parseFloat(agg.cycle_volume_usd) : 0;
  const bindLifetime = agg && agg.lifetime_volume_usd ? parseFloat(agg.lifetime_volume_usd) : 0;
  const appdataCycle = appdataAgg ? parseFloat(appdataAgg.cycle_volume_usd) : 0;
  const appdataLifetime = appdataAgg ? parseFloat(appdataAgg.lifetime_volume_usd) : 0;
  // Cycle NET fee (USD) = SUM(value * bps * keepFractionBps(chain)) / 1e8 across
  // bind + appData (disjoint), matching the per-trade, per-chain accrual (sovereign
  // OP/Unichain keep 100%, hosted 75%). The /1e8 unscales both the bps (1e4) and the
  // keep bps (1e4). Drives the fee-aware earnings estimate (no ~2x for SDK; sovereign
  // chains not understated 25%).
  const bindNetWeighted = agg && agg.cycle_net_weighted ? parseFloat(agg.cycle_net_weighted) : 0;
  const appdataNetWeighted = appdataAgg ? parseFloat(appdataAgg.cycle_net_weighted) : 0;
  const currentCycleNetFeeUsd = (bindNetWeighted + appdataNetWeighted) / 100_000_000;

  return {
    wallet: referrer,
    kind,
    rateOfNetFeePct: FEE_SHARE_BPS[kind] / 100, // 8 or 12
    activeCodes: codes.filter((c) => c.active).map((c) => c.code),
    referredCount: agg ? parseInt(agg.referred_count, 10) : 0,
    // Bind + appData volume (disjoint). Drives both the display and the partner
    // earnings estimate, so the dashboard now matches the payout.
    currentCycleVolumeUsd: bindCycle + appdataCycle,
    // Actual cycle NET fee (Σ value*bps*keep/1e8) for the fee-aware earnings estimate.
    currentCycleNetFeeUsd,
    // Partners display lifetime referred volume (bind + appData); regular never
    // displays lifetime (stays 0, unchanged).
    lifetimeReferredVolumeUsd: isPartner ? bindLifetime + appdataLifetime : 0,
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

function enrollmentQueueMax(): number {
  const raw = process.env.REBATE_ENROLLMENT_QUEUE_MAX?.trim();
  if (!raw) return 5_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`REBATE_ENROLLMENT_QUEUE_MAX must be a non-negative integer; got "${raw}"`);
  }
  return parsed;
}

async function admitTrackedWallet(rawWallet: `0x${string}`): Promise<boolean> {
  const maxQueued = enrollmentQueueMax();
  const walletHex = rawWallet.slice(2);

  // FAST PATH (no lock). A wallet that is already tracked OR already has an indexed
  // trade is ALWAYS admitted and never counts against the enrollment cap:
  //   - already-tracked: idempotent — the common case for legitimate repeat traffic
  //     on /tier and /xp (100/min each), so it must NOT serialize on the global
  //     admission lock in the slow path below.
  //   - proven (has trades): a real Ophis trader, so it can never be 429'd by a spam
  //     backlog. This covers eth-flow synthetic-owner fetches, which attribute trades
  //     to a RECEIVER without ever adding that receiver to tracked_wallets — such a
  //     wallet is enrolled here (uncapped, idempotent) so the fetcher refreshes its
  //     future trades. The INSERT fires only for a proven-but-untracked wallet; for a
  //     plain already-tracked read it selects zero rows.
  const [pre] = await sql<{ admit: boolean }[]>`
    WITH candidate AS (
      SELECT decode(${walletHex}, 'hex') AS wallet
    ), status AS (
      SELECT
        EXISTS (SELECT 1 FROM tracked_wallets tw WHERE tw.wallet = (SELECT wallet FROM candidate)) AS tracked,
        EXISTS (SELECT 1 FROM trades t WHERE t.wallet = (SELECT wallet FROM candidate)) AS proven
    ), enroll_proven AS (
      INSERT INTO tracked_wallets (wallet)
      SELECT wallet FROM candidate
      WHERE (SELECT proven FROM status) AND NOT (SELECT tracked FROM status)
      ON CONFLICT (wallet) DO NOTHING
      RETURNING 1
    )
    SELECT ((SELECT tracked FROM status) OR (SELECT proven FROM status)) AS admit
  `;
  if (pre?.admit) return true;

  // SLOW PATH: a genuinely NEW, unproven wallet. Serialize admissions on a global
  // advisory xact lock so the backlog count and the insert are ATOMIC. Without it a
  // burst of concurrent new wallets each reads the same sub-cap count before any
  // insert commits, so they all pass the predicate — turning the cap into a soft
  // per-race limit instead of a hard backlog bound. Same pattern as the /ref/bind
  // lock; distinct key. Taken ONLY for first-time unproven enrollments (the abuse
  // surface), never for the lock-free fast path above. Auto-releases at tx end.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(731948)`;
    const rows = await tx<{ accepted: boolean }[]>`
      WITH candidate AS (
        SELECT decode(${walletHex}, 'hex') AS wallet
      ), status AS (
        -- Re-check under the lock: another admission may have inserted or proven this
        -- wallet since the fast-path read above.
        SELECT
          EXISTS (SELECT 1 FROM tracked_wallets tw WHERE tw.wallet = (SELECT wallet FROM candidate)) AS tracked,
          EXISTS (SELECT 1 FROM trades t WHERE t.wallet = (SELECT wallet FROM candidate)) AS proven
      ), backlog AS (
        -- Unproven backlog = EVERY tracked wallet with no indexed trade yet, NOT just
        -- the never-attempted ones. The old (last_fetched IS NULL AND last_attempt_at
        -- IS NULL) filter let a caller re-fill the queue after every fetcher pass: a
        -- spam wallet dropped out of the total the instant the fetcher attempted it
        -- (even with zero trades), yet lingered — and kept getting refreshed — until
        -- the 7-day prune. Counting all unproven rows makes the cap a real bound on
        -- the unproven fetch workload.
        SELECT COUNT(*)::int AS queued
        FROM tracked_wallets tw
        WHERE NOT EXISTS (SELECT 1 FROM trades t WHERE t.wallet = tw.wallet)
      ), inserted AS (
        INSERT INTO tracked_wallets (wallet)
        SELECT wallet FROM candidate
        WHERE (SELECT tracked FROM status)
           OR (SELECT proven FROM status)
           OR (SELECT queued FROM backlog) < ${maxQueued}
        ON CONFLICT (wallet) DO NOTHING
        RETURNING 1
      )
      SELECT (
        (SELECT tracked FROM status)
        OR (SELECT proven FROM status)
        OR EXISTS (SELECT 1 FROM inserted)
      ) AS accepted
    `;
    // Fail CLOSED: only an explicit accepted=true admits. The final SELECT (no FROM)
    // always returns exactly one row today, but if a future edit ever made it return
    // zero rows, `!== false` would fail OPEN (admit past the cap) — deny instead.
    return rows[0]?.accepted === true;
  });
}

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

  // CORS — the swap page (ophis.fi + *.pages.dev) calls /tier directly, and the
  // affiliate/partner pages issue SIGNED POSTs to /partner, /ref/bind, /ref/codes.
  // Those POSTs send `content-type: application/json` (a non-safelisted header),
  // which forces the browser to send a CORS PREFLIGHT (OPTIONS) first. The browser
  // only sends the real POST if that preflight response echoes the requested method
  // in Access-Control-Allow-Methods AND `content-type` in Access-Control-Allow-Headers.
  // Setting allow-origin alone (the old behaviour) passed simple GETs but silently
  // blocked every signed POST -> the partner dashboard failed with a network error.
  // Set the full preflight allowance for allowed origins (harmless on actual
  // GET/POST responses; load-bearing on the OPTIONS 204).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const allowed = ['https://ophis.fi', 'https://www.ophis.fi', 'https://swap.ophis.fi'];
    // /tier/:wallet (wallet enrollment) and /ref/:code (code lookup) are PUBLIC,
    // unauthenticated, idempotent, credential-free reads. Allow ANY browser origin
    // so a partner web app can enroll wallets via @ophis/sdk's enrollOphisTrader on
    // wallet-connect (the Ophis swap page is no longer the only browser caller).
    // `*` is safe here precisely because these endpoints carry no cookies/auth, and
    // the enrollment upsert already happens server-side regardless of CORS; the
    // header only lets the browser READ the response. Credentialed POSTs (/partner,
    // /ref/bind) keep the strict allow-list below.
    // GET only: the enrollment/lookup call is a SIMPLE cross-origin GET (its
    // only header is the safelisted `accept`), so no preflight is involved and
    // the GET response just needs allow-origin. Crucially this does NOT match the
    // OPTIONS preflights of the signed POST routes /ref/bind and /ref/codes (which
    // also start with /ref/), so those keep falling through to the strict
    // allow-list branch and still receive POST in Access-Control-Allow-Methods.
    const isPublicRead =
      req.method === 'GET' &&
      (req.url.startsWith('/tier/') || req.url.startsWith('/ref/') || req.url.startsWith('/xp/'));
    if (isPublicRead) {
      reply.header('access-control-allow-origin', '*');
      reply.header('vary', 'Origin');
    } else if (origin && allowed.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      reply.header('access-control-allow-headers', 'content-type, accept');
      reply.header('access-control-max-age', '600');
      reply.header('vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    }
  });
  app.options('*', async (_req, reply) => reply.code(204).send());

  // rebates.ophis.fi is the rebate-indexer API host (JSON endpoints + the
  // per-wallet /tier HTML page). Google was crawling the bare host root and
  // flagging it 404 (GSC, 2026-06). Fix: redirect the root to the public rebate
  // explainer (so the flagged URL stops 404ing), and keep the API/tier sub-paths
  // out of the index. robots ALLOWS exactly `/` (so crawlers can see+follow the
  // 301) but disallows everything else; `Allow: /$` wins by longest-match over
  // `Disallow: /` for the root only.
  app.get('/', {
    config: {
      rateLimit: { max: 200, timeWindow: '1 minute' },
    },
  }, async (_req, reply) => reply.code(301).redirect('https://docs.ophis.fi/affiliate'));

  app.get('/robots.txt', {
    config: {
      rateLimit: { max: 200, timeWindow: '1 minute' },
    },
  }, async (_req, reply) =>
    // /health is allowed so Bing can crawl it and read its noindex header (a bare
    // Disallow makes Bing report it as "blocked by robots.txt"). /stats is the
    // public cumulative-proof page (indexable for discoverability). Everything
    // else (incl. wallet-scoped /tier) stays disallowed for privacy + crawl budget.
    reply.code(200).type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\nAllow: /$\nAllow: /health\nAllow: /stats\n'),
  );

  app.get('/health', {
    config: {
      rateLimit: { max: 200, timeWindow: '1 minute' }, // permissive — uptime monitors hit this continuously
    },
  }, async (_req, reply) => {
    // Crawlable (robots.txt allows /health) but kept OUT of the search index via a
    // noindex header, so Bing reads it instead of reporting "blocked by robots" and
    // never indexes the operational JSON. X-Robots-Tag applies to non-HTML responses.
    reply.header('X-Robots-Tag', 'noindex');
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
    // run. Admission is globally bounded so unauthenticated public reads cannot
    // fill an unbounded never-fetched backlog ahead of later legitimate users.
    if (!(await admitTrackedWallet(raw as `0x${string}`))) {
      return reply.code(429).send({ error: 'rebate enrollment queue is full; place an Ophis order or retry later' });
    }
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

  // PUBLIC cumulative stats: lifetime settled volume, trades, traders, and a
  // per-chain breakdown, from the indexed `trades` table, plus static
  // execution-model facts (EXECUTION_FACTS) and the derived lifetime average
  // trade size. Deliberately cumulative/lagging ONLY: it never exposes
  // current-cycle 30d volume or the next-payout timing (those stay on the
  // admin-only /status, where they are a front-runner timing signal).
  // Cumulative lifetime totals and configuration facts are not gameable, so
  // this is a safe public credibility/proof surface. JSON for API clients;
  // a styled page for a browser (same content-negotiation as /tier).
  app.get('/stats', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' }, // public
    },
  }, async (req, reply) => {
    // Public production proof surface: restrict to the named mainnet chains so
    // testnet settlement dust (e.g. Sepolia 11155111) never inflates or clutters
    // the cumulative figures. A plain mutable copy for postgres-js array binding.
    const chainIds = [...PRODUCTION_CHAIN_IDS];
    const totalsRows = await sql<{ vol: string | null; trades: string; traders: string; chains: string; avg_trade: string | null }[]>`
      SELECT
        COALESCE(SUM(value_usd), 0)::text AS vol,
        COUNT(*)::text                    AS trades,
        COUNT(DISTINCT wallet)::text      AS traders,
        COUNT(DISTINCT chain_id)::text    AS chains,
        -- AVG ignores NULLs, so this is the average over PRICED trades only.
        -- It avoids dividing priced volume by the all-trades count (which would
        -- understate while some trades are still awaiting a price).
        ROUND(AVG(value_usd)::numeric, 2)::text AS avg_trade
      FROM trades
      WHERE chain_id = ANY(${chainIds})
    `;
    const byChainRows = await sql<{ chain_id: number; vol: string | null; n: string }[]>`
      SELECT chain_id, COALESCE(SUM(value_usd), 0)::text AS vol, COUNT(*)::text AS n
      FROM trades
      WHERE chain_id = ANY(${chainIds})
      GROUP BY chain_id
      ORDER BY SUM(value_usd) DESC NULLS LAST, COUNT(*) DESC
    `;
    const t = totalsRows[0];
    const stats: PublicStats = {
      totalVolumeUsd: Number(t?.vol ?? '0'),
      totalTrades: Number(t?.trades ?? '0'),
      distinctTraders: Number(t?.traders ?? '0'),
      chainsActive: Number(t?.chains ?? '0'),
      byChain: byChainRows.map((r) => ({
        chainId: r.chain_id,
        volumeUsd: Number(r.vol ?? '0'),
        trades: Number(r.n),
      })),
      generatedAt: new Date().toISOString(),
    };

    reply.header('vary', 'Origin, Accept');
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html')) {
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        )
        .send(renderStatsPage(stats));
    }
    // Lifetime average trade size over PRICED trades only (SQL AVG ignores
    // NULLs), so it is not skewed low by trades still awaiting a price. Null
    // until at least one priced trade is indexed. Lagging-only, no extra signal.
    const avgTradeUsd = t?.avg_trade != null ? Number(t.avg_trade) : null;
    return { ok: true, ...stats, avgTradeUsd, execution: EXECUTION_FACTS };
  });

  // PUBLIC, keyless, per-appCode integrator earnings - the trust surface that lets an
  // integrator verify what their own-fee routing earned and where it paid out. Same
  // keyless posture as /tier and /stats. Reports CUMULATIVE (lifetime) routed volume +
  // fee accrual + EXACT paid-to-date referral share; the "guaranteed/paid" figures are
  // scoped to the Ophis-operated chains (OP + Unichain), and CoW-hosted figures are
  // labeled accrued-and-CoW-disbursed via the disclaimer (see src/earnings.ts).
  //
  // Deliberately mirrors the /stats security invariant: it NEVER exposes current-cycle
  // 30d volume, an estimated current-cycle earning, or next-payout timing (front-runner
  // signals kept on the admin-only /status and the sig-gated /partner).
  app.get<{ Params: { appCode: string } }>('/earnings/:appCode', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' }, // public - matches /stats
    },
  }, async (req, reply) => {
    const code = req.params.appCode.toLowerCase();
    // Same grammar as a referral code (appdata_ref_code is the key): 3-64 [a-z0-9_-].
    if (!/^[a-z0-9_-]{3,64}$/.test(code)) return reply.code(400).send({ error: 'invalid appCode' });
    reply.header('vary', 'Origin');
    const earnings = await getIntegratorEarnings(code, new Date());
    return { ok: true, ...earnings };
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
        if (inserted.length > 0) return { code: candidate, kind: 'regular', created: true };
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
        -- Mirror the headline stats + accrual bind arm so each referee's shown bind
        -- volume == the corrected headline + payout:
        --   (1) fee-gate out examined-0 trades. A settle() DISCOVERY row credits
        --       nothing (volume_fee_bps=0), so it must not inflate a referee's shown
        --       volume; NULL is KEPT (the retail-default bind semantics). Same
        --       IS DISTINCT FROM 0 gate as the headline (the bind arm above).
        AND t.volume_fee_bps IS DISTINCT FROM 0
        --   (2) appData-wins: exclude trades attributed via an active code owned by
        --       someone OTHER than the trader.
        AND NOT (t.appdata_ref_code IS NOT NULL AND EXISTS (
          SELECT 1 FROM ref_codes rc2 WHERE rc2.code = t.appdata_ref_code AND rc2.active AND rc2.referrer_wallet <> t.wallet
        ))
        --   (3) production chains only, mirroring the headline stats + accrual, so
        --       per-referee rows reconcile with the totals (Codex post-merge review).
        AND t.chain_id <> 11155111
      WHERE r.referrer_wallet = ${buf}
      GROUP BY r.referred_wallet, r.bound_at
      ORDER BY r.bound_at DESC
      LIMIT 500
    `;
    // Earnings panel figures. Estimated current-cycle earnings are FEE-AWARE: the
    // tier share of the actual cycle fee base (Σ value*bps), so a 5 bps SDK partner
    // sees roughly what the payout pays, not ~2x. Paid-to-date is exact, summed from
    // the executed monthly Safe batches. Next payout is the 1st of next month, 02:00 UTC.
    const estimatedCurrentCycleEarningsUsd = estimateEarningsFromNetFeeUsd(
      stats.currentCycleNetFeeUsd,
      stats.currentCycleVolumeUsd,
      stats.kind,
    );
    const [paid] = await sql<{ paid_weth: number; paid_usd: number }[]>`
      SELECT
        COALESCE(SUM(e.paid_wei::numeric) / 1e18, 0)::float8 AS paid_weth,
        COALESCE(SUM((e.paid_wei::numeric / 1e18) * COALESCE(b.weth_usd_price, 0)), 0)::float8 AS paid_usd
      FROM affiliate_batch_entries e
      JOIN affiliate_batches b ON b.id = e.batch_id
      WHERE e.referrer_wallet = ${buf} AND e.status = 'paid'
    `;
    return {
      ...stats,
      estimatedCurrentCycleEarningsUsd,
      paidToDateWeth: paid?.paid_weth ?? 0,
      paidToDateUsd: paid?.paid_usd ?? 0,
      nextPayoutAt: nextFirstOfMonth().toISOString(),
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

  app.get<{ Querystring: { limit?: string; self?: string } }>('/leaderboard', {
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
    // Optional self-identification: the connected wallet (full address) so the
    // response can mark its own row (isSelf). Validated to a 0x-address shape;
    // any malformed value is ignored (the leaderboard is still returned, unmarked).
    let self: string | undefined;
    if (req.query.self) {
      const raw = req.query.self.toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(raw)) self = raw;
    }
    reply.header('vary', 'Origin');
    if ('self' in req.query) {
      // Any request carrying `self` is caller-specific (isSelf), so it must never
      // be served from a shared cache to a different wallet. Keyed on the PRESENCE
      // of the param (not its truthiness/validity) so even `?self=` or a malformed
      // value can't slip a caller-tagged URL into a shared cache.
      reply.header('cache-control', 'private, no-store');
    } else {
      reply.header('cache-control', 'public, max-age=60');
    }
    const leaderboard = await getLeaderboard(limit, self);
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

  // PUBLIC per-wallet XP for the Cash Prize page: 1 XP per $1 of the wallet's
  // own lifetime fee-bearing volume. Lifetime/cumulative only, so it sits in
  // the same lagging, non-gameable category as /stats (per-wallet 30d volume
  // is already public on /tier and /rank). Fee-gated exactly like the
  // `wallets` matview (volume_fee_bps = 0 means examined-and-fee-free, which
  // must not mint XP) and restricted to production chains so testnet dust
  // never unlocks a perk. Unknown wallets get 200 with xp 0, not 404: the
  // page treats "never traded" as zero progress, not an error.
  app.get<{ Params: { wallet: string } }>('/xp/:wallet', {
    config: {
      rateLimit: { max: 100, timeWindow: '1 minute' }, // public endpoint
    },
  }, async (req, reply) => {
    const raw = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) return reply.code(400).send({ error: 'invalid wallet address' });
    // Enroll like /tier, but behind the same global admission cap so Rewards
    // page traffic cannot create an unbounded never-fetched backlog.
    if (!(await admitTrackedWallet(raw as `0x${string}`))) {
      return reply.code(429).send({ error: 'rebate enrollment queue is full; place an Ophis order or retry later' });
    }
    const walletBuf = Buffer.from(raw.slice(2), 'hex');
    const chainIds = [...PRODUCTION_CHAIN_IDS];
    const rows = await sql<{ vol: string }[]>`
      SELECT COALESCE(SUM(value_usd), 0)::text AS vol
      FROM trades
      WHERE wallet = ${walletBuf}
        AND chain_id = ANY(${chainIds})
        AND value_usd IS NOT NULL
        AND (volume_fee_bps IS NULL OR volume_fee_bps > 0)
    `;
    const lifetimeVolumeUsd = Number(rows[0]?.vol ?? '0');
    reply.header('vary', 'Origin');
    reply.header('cache-control', 'public, max-age=60');
    return {
      wallet: raw,
      xp: Math.floor(lifetimeVolumeUsd),
      lifetimeVolumeUsd,
      generatedAt: new Date().toISOString(),
    };
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
