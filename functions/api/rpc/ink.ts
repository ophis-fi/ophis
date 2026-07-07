/**
 * Server-side JSON-RPC proxy for Ink (chain 57073) — Ophis edge for Ink RPC.
 *
 * WHY: today the frontend's Ink RPC reads (balances, quotes, multicall, logs)
 * go straight from each visitor's browser to Ink's public node
 * (`rpc-ten`/`rpc-gel`.inkonchain.com), leaking the visitor's IP + queried
 * addresses to a third party. This mirrors the exact problem the F1 divergence
 * (2026-05-20) fixed for the other chains by moving off Infura: route reads
 * through Ophis's own edge so user IPs stay behind ophis.fi. Both the frontend
 * (REACT_APP_NETWORK_URL_57073 -> this same-origin path) and the MCP server
 * point here, so there is ONE shared, upgradeable Ink endpoint.
 *
 * DEDICATED ENDPOINT SLOT: Ink provisions per-partner RPC endpoints with a
 * secret path token (the Dec-2024 dev-mainnet token is expired — verified 401).
 * When a FRESH dedicated endpoint is obtained from the Ink team, set it as the
 * `INK_RPC_URL` Cloudflare Pages runtime secret; this proxy switches upstream
 * with NO code change. The secret path stays server-side and never reaches the
 * browser bundle or the public repo.
 *
 * SAFE BY DEFAULT: if `INK_RPC_URL` is unset, upstream is the public
 * `rpc-gel.inkonchain.com` (keyless, works), so the proxy degrades to plain
 * public-node behavior rather than breaking Ink reads.
 *
 * ACCESS CONTROLS (this is a public CF Pages endpoint; "same-origin" is a
 * deployment fact, not enforcement — curl can hit it, and once a dedicated key
 * is set every accepted request spends Ophis's quota). Mirrors
 * functions/api/bungee:
 *   - Method allowlist: POST (JSON-RPC) + OPTIONS (CORS preflight) only.
 *   - JSON-RPC method DENYLIST: state-changing / node-control methods are
 *     rejected — tx broadcast (eth_sendRawTransaction/eth_sendTransaction:
 *     wallets broadcast via the user's own provider, never this read RPC, so
 *     blocking them stops the endpoint being abused as a free relay),
 *     subscriptions, and the admin_/debug_/txpool_/miner_/personal_/engine_
 *     namespaces. A denylist (not an allowlist) is deliberate: Ink is a live
 *     chain, so we must never break an unanticipated read method — reads all
 *     pass, and read-abuse is bounded by the rate limit + body cap. Batch
 *     requests are validated per-entry; one denied entry rejects the batch.
 *   - Origin gate: a PRESENT non-allowlisted Origin is rejected (absent Origin
 *     — server-side MCP fetch, curl — passes; the rate limit is the backstop).
 *   - Per-IP rate limit: KV sliding window (OPHIS_RATELIMIT, shared namespace
 *     with /api/intent + /api/bungee under a distinct key prefix), per-isolate
 *     in-memory fallback when KV is unbound/unavailable.
 *   - Body cap: 256 KB — plenty for batched multicall / eth_getLogs param
 *     arrays; blocks abusive oversized POSTs.
 */

interface Env {
  /** Fresh dedicated Ink RPC endpoint (full URL incl. secret path). CF Pages runtime secret. */
  INK_RPC_URL?: string
  /** KV namespace shared with /api/intent + /api/bungee — distributed per-IP rate limit. */
  OPHIS_RATELIMIT?: KVNamespace
}

// Keyless public Ink node — works today, used until a fresh dedicated endpoint
// is set as INK_RPC_URL. `rpc-gel` verified live (eth_chainId -> 0xdef1).
const DEFAULT_UPSTREAM = 'https://rpc-gel.inkonchain.com'

// Denied JSON-RPC methods: state-changing tx broadcast + subscriptions. Ink is
// a live chain, so we DENY rather than allowlist — every read passes (no risk of
// breaking an unanticipated read the frontend/viem needs), while the free-relay
// vector (broadcasting txs on Ophis's key) is closed. Wallets broadcast via the
// user's own injected provider, never this read RPC, so nothing legitimate here
// sends transactions.
const DENIED_RPC_METHODS = new Set<string>([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_subscribe',
  'eth_unsubscribe',
])
// Denied namespaces (node control / introspection / heavy trace). Any method
// starting with one of these prefixes is rejected.
const DENIED_RPC_PREFIXES = ['admin_', 'debug_', 'txpool_', 'miner_', 'personal_', 'engine_', 'trace_']

function isDeniedMethod(method: unknown): boolean {
  if (typeof method !== 'string') return true // no/invalid method -> reject
  if (DENIED_RPC_METHODS.has(method)) return true
  return DENIED_RPC_PREFIXES.some((p) => method.startsWith(p))
}

// Mirrors functions/api/bungee + functions/api/intent — the hosts this Pages
// project serves. Reject only a PRESENT non-allowlisted Origin; same-origin
// swap.ophis.fi POSTs and server-side (MCP) fetches pass.
const ALLOWED_ORIGINS = new Set<string>([
  'https://ophis.fi',
  'https://swap.ophis.fi',
  'https://business.ophis.fi',
])

const MAX_REQUEST_BODY_BYTES = 256 * 1024

// Sliding-window per-IP rate limit. Ink read polling (quote refresh + multicall
// while a swap form is open) is chatty, so more generous than /api/intent.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 300
const RATE_LIMIT_MAX_KEYS = 1024
// Distinct prefix so entries never collide with intent (`rl:`) / bungee
// (`bungee:rl:`) keys in the shared OPHIS_RATELIMIT namespace.
const RATE_LIMIT_KEY_PREFIX = 'inkrpc:rl:'

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin)
}

// CORS headers for an allowlisted Origin. Same-origin (swap.ophis.fi) reads
// don't need these; they let the app also read Ink from the apex/business host
// without a preflight failure. Server-side callers (no Origin) get none.
function corsHeaders(origin: string | null): Record<string, string> {
  if (origin && isAllowedOrigin(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'Origin',
    }
  }
  return {}
}

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

function jsonError(status: number, error: string, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: error } }), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  })
}

// Validate a parsed JSON-RPC payload (single or batch): every entry must be an
// object whose `method` is NOT denied. Empty/oversized batches, non-objects, and
// any denied method reject the whole request.
function isAllowedPayload(payload: unknown): boolean {
  const entries = Array.isArray(payload) ? payload : [payload]
  if (entries.length === 0 || entries.length > 100) return false
  return entries.every(
    (e) => e != null && typeof e === 'object' && !isDeniedMethod((e as { method?: unknown }).method),
  )
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }
  if (request.method !== 'POST') {
    return jsonError(405, 'method not allowed — JSON-RPC POST only', { ...cors, allow: 'POST, OPTIONS' })
  }
  if (origin && !isAllowedOrigin(origin)) {
    return jsonError(403, 'origin not allowed', cors)
  }

  // Ingress body cap. Fast-reject an oversized DECLARED content-length, then
  // stream and abort the moment the running total crosses the cap so an absent
  // or lying content-length can't force a large payload into memory.
  const declaredLen = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLen) && declaredLen > MAX_REQUEST_BODY_BYTES) {
    return jsonError(413, 'request body too large', cors)
  }
  let bodyBytes: Uint8Array
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
        return jsonError(413, 'request body too large', cors)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    bodyBytes = merged
  } else {
    return jsonError(400, 'empty request body', cors)
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes))
  } catch {
    return jsonError(400, 'invalid JSON', cors)
  }
  if (!isAllowedPayload(payload)) {
    return jsonError(403, 'rpc method not allowed', cors)
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if (!(await checkRateLimit(env, ip))) {
    return jsonError(429, 'too many requests', { ...cors, 'retry-after': '10' })
  }

  const upstream = (env.INK_RPC_URL || DEFAULT_UPSTREAM).replace(/\/+$/, '')

  let upstreamResp: Response
  try {
    upstreamResp = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyBytes,
    })
  } catch {
    return jsonError(502, 'ink upstream unreachable', cors)
  }

  // Pass through status + body; forward only content-type (never upstream
  // headers, which on a dedicated endpoint could echo the auth back).
  const respHeaders = new Headers(cors)
  respHeaders.set('content-type', upstreamResp.headers.get('content-type') || 'application/json')
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: respHeaders })
}
