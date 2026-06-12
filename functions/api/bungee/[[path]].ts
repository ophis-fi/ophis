/**
 * Server-side proxy for Bungee bridge API calls (Ophis dedicated integrator).
 *
 * WHY: to charge Ophis's own bridge fee, Bungee's dedicated tier requires an
 * `x-api-key` header, and Bungee's docs mandate it stay SERVER-SIDE (never in
 * the browser bundle, where it could be extracted / rate-limit-drained). So the
 * frontend bridging SDK points its Bungee `apiBaseUrl` at this same-origin
 * proxy; we inject the key here and forward to Bungee. The integrator feeBps is
 * configured in the Bungee dashboard (bound to the key), not passed per-request.
 *
 * SAFE BY DEFAULT: if `BUNGEE_API` is unset, we forward WITHOUT the key, so the
 * proxy degrades to plain affiliate-attribution behavior rather than breaking
 * bridge quotes. The upstream host is `BUNGEE_BACKEND` (default the standard
 * backend, which works keyless); set it to the dedicated backend once the
 * dedicated integrator is confirmed with Bungee.
 *
 * ACCESS CONTROLS (audit 2026-06-09 — this is a public CF Pages endpoint, and
 * "same-origin" is a deployment fact, not an enforcement; curl can hit it
 * directly, and once BUNGEE_API is set every accepted request spends Ophis's
 * dedicated-tier quota):
 *   - Method allowlist: GET/POST only (the bridging SDK uses nothing else).
 *   - Path allowlist: /api/v1/bungee(-manual)/... only — the two API roots the
 *     SDK is configured with in bridgingSdk.ts. Everything else 404s without
 *     touching the upstream.
 *   - Origin gate: browsers send Origin on cross-origin requests and on all
 *     POSTs; a present-but-unrecognized Origin is rejected. (Absent Origin —
 *     same-origin GETs, curl — passes, like /api/intent; the rate limit is the
 *     backstop for non-browser callers.)
 *   - Per-IP rate limit: KV-backed sliding window (OPHIS_RATELIMIT, shared
 *     namespace with /api/intent under a distinct key prefix), per-isolate
 *     in-memory fallback when KV is unbound/unavailable.
 *
 * Routing: CF Pages catch-all. /api/bungee/<rest> -> ${BUNGEE_BACKEND}/<rest>,
 * method + query + body forwarded verbatim.
 *
 * ACTIVATION (not live until all of):
 *   1. BUNGEE_API set as a Cloudflare Pages runtime secret (NOT just a GitHub
 *      Actions secret — CF Functions read the Pages project env at runtime).
 *   2. BUNGEE_BACKEND set to the confirmed dedicated host (if it differs).
 *   3. The frontend built with REACT_APP_BUNGEE_DEDICATED_ENABLED=true so the
 *      SDK routes through this proxy.
 *   4. Verify the access controls above are active on the deployed function:
 *      a DELETE, a /api/v1/other path, and a forged-Origin POST must all be
 *      rejected, and >RATE_LIMIT_MAX_REQUESTS requests/min from one IP must
 *      429 — BEFORE the key is set.
 *   5. A live bridge-quote test confirming the fee accrues to the Safe.
 */

interface Env {
  /** Bungee dedicated-integrator API key (Cloudflare Pages runtime secret). */
  BUNGEE_API?: string
  /** Upstream Bungee host override. Default = the dedicated backend. */
  BUNGEE_BACKEND?: string
  /** KV namespace shared with /api/intent — distributed per-IP rate limit. */
  OPHIS_RATELIMIT?: KVNamespace
}

// Bungee's dedicated-integrator host (confirmed in their API-access docs). The
// proxy is only reached when the dedicated tier is enabled, so it targets the
// dedicated backend by default; override with BUNGEE_BACKEND if Bungee changes it.
const DEFAULT_BACKEND = 'https://dedicated-backend.bungee.exchange'

// Forward only safe request headers; the `affiliate` id arrives from the SDK
// and is public, so it is passed through. Hop-by-hop / host / cookie headers
// are intentionally dropped.
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'affiliate']

// The two upstream API roots the bridging SDK is configured with
// (bridgingSdk.ts: apiBaseUrl=/api/v1/bungee, manualApiBaseUrl=/api/v1/bungee-manual).
const ALLOWED_PATH_RE = /^\/api\/v1\/bungee(-manual)?(\/|$)/

const ALLOWED_METHODS = new Set(['GET', 'POST'])

// Cap proxied request bodies. Bungee bridge quote/build payloads are small JSON
// (well under a few KB); a 64 KB ceiling blocks abusive oversized POSTs from
// spending Ophis's dedicated-tier quota or upstream bandwidth. Enforced against
// both the declared content-length and the actual bytes read.
const MAX_REQUEST_BODY_BYTES = 64 * 1024

// Mirrors functions/api/intent.ts ALLOWED_ORIGINS — the hosts this Pages
// project serves. Reject only a PRESENT non-allowlisted Origin: same-origin
// GET fetches legitimately omit the header.
const ALLOWED_ORIGINS = new Set<string>([
  'https://ophis.fi',
  'https://swap.ophis.fi',
  'https://business.ophis.fi',
])
// No .pages.dev origins: the CF Pages project URL is non-canonical and not
// allowlisted, forcing the ophis.fi custom domains as the only origins.
const ALLOWED_ORIGIN_SUFFIXES: string[] = []

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    const url = new URL(origin)
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => url.host.endsWith(suffix))
  } catch {
    return false
  }
}

// Sliding-window per-IP rate limit. More generous than /api/intent's 30/min:
// bridge quoting legitimately polls (quote refresh while the form is open),
// and the guarded resource is third-party API quota, not a metered LLM call.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 120
const RATE_LIMIT_MAX_KEYS = 1024
// Distinct prefix so entries never collide with /api/intent's `rl:` keys in
// the shared OPHIS_RATELIMIT namespace.
const RATE_LIMIT_KEY_PREFIX = 'bungee:rl:'

async function checkRateLimitKV(kv: KVNamespace, ip: string): Promise<boolean> {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const key = `${RATE_LIMIT_KEY_PREFIX}${ip}`
  const raw = await kv.get(key)
  let timestamps: number[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) timestamps = parsed.filter((t) => typeof t === 'number' && t > cutoff)
    } catch {
      timestamps = []
    }
  }
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) return false
  timestamps.push(now)
  await kv.put(key, JSON.stringify(timestamps), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) * 2 })
  return true
}

// Per-isolate fallback (KV unbound or erroring): coarse but better than open.
const isolateHits = new Map<string, number[]>()

function checkRateLimitIsolate(ip: string): boolean {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  if (isolateHits.size > RATE_LIMIT_MAX_KEYS) isolateHits.clear()
  const timestamps = (isolateHits.get(ip) ?? []).filter((t) => t > cutoff)
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    isolateHits.set(ip, timestamps)
    return false
  }
  timestamps.push(now)
  isolateHits.set(ip, timestamps)
  return true
}

async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  if (env.OPHIS_RATELIMIT) {
    try {
      return await checkRateLimitKV(env.OPHIS_RATELIMIT, ip)
    } catch {
      return checkRateLimitIsolate(ip)
    }
  }
  return checkRateLimitIsolate(ip)
}

function jsonError(status: number, error: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const url = new URL(request.url)

  if (!ALLOWED_METHODS.has(request.method)) {
    return jsonError(405, 'method not allowed', { allow: 'GET, POST' })
  }

  const origin = request.headers.get('origin')
  if (origin && !isAllowedOrigin(origin)) {
    return jsonError(403, 'origin not allowed')
  }

  // Strip the /api/bungee prefix to recover the upstream path.
  const rest = url.pathname.replace(/^\/api\/bungee/, '') || '/'
  // Reject encoded path traversal before the allowlist check. `URL` normalizes
  // literal `/../` and `/./` in pathname but keeps %2f/%5c (encoded slash and
  // backslash) verbatim, so an allowlisted prefix like
  // /api/v1/bungee/..%2f..%2fx could decode upstream and escape the bungee
  // prefix on the (fixed) backend host. We also reject %2e (encoded dot): the
  // URL parser leaves it verbatim, so /api/v1/bungee/%2e%2e/x could decode to
  // /api/v1/bungee/../x upstream and escape even without an encoded slash.
  // Legit Bungee paths never contain encoded separators or dots; query params
  // live in url.search and are appended separately.
  if (/%2e|%2f|%5c/i.test(rest)) {
    return jsonError(404, 'unknown bungee api path')
  }
  if (!ALLOWED_PATH_RE.test(rest)) {
    return jsonError(404, 'unknown bungee api path')
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if (!(await checkRateLimit(env, ip))) {
    return jsonError(429, 'too many requests', { 'retry-after': '30' })
  }

  const backend = (env.BUNGEE_BACKEND || DEFAULT_BACKEND).replace(/\/+$/, '')
  const upstream = `${backend}${rest}${url.search}`

  const headers = new Headers()
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(h)
    if (v) headers.set(h, v)
  }
  // Inject the dedicated key server-side. Absent -> keyless passthrough.
  if (env.BUNGEE_API) headers.set('x-api-key', env.BUNGEE_API)

  const init: RequestInit = { method: request.method, headers }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Cap the request body at MAX_REQUEST_BODY_BYTES. Fast path: reject an
    // oversized DECLARED content-length before reading anything. Then stream the
    // body and abort the moment the running total crosses the cap, so an absent
    // or lying content-length cannot force a large payload into Worker memory.
    // This is a true ingress cap, not a buffer-everything-then-measure check.
    const declaredLen = Number(request.headers.get('content-length'))
    if (Number.isFinite(declaredLen) && declaredLen > MAX_REQUEST_BODY_BYTES) {
      return jsonError(413, 'request body too large')
    }
    if (request.body) {
      const reader = request.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > MAX_REQUEST_BODY_BYTES) {
          await reader.cancel()
          return jsonError(413, 'request body too large')
        }
        chunks.push(value)
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      init.body = merged
    }
  }

  let upstreamResp: Response
  try {
    upstreamResp = await fetch(upstream, init)
  } catch {
    return jsonError(502, 'bungee upstream unreachable')
  }

  // Pass through status + body; only forward content-type (no upstream secrets/headers).
  const respHeaders = new Headers()
  const ct = upstreamResp.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: respHeaders })
}
