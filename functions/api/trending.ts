/**
 * GET /api/trending?chainId=10
 *
 * Returns the trending tokens for one chain (by 1h movement / volume), so the
 * swap widget can show an in-app "Trending" panel. Browser → this function →
 * GeckoTerminal's keyless market API.
 *
 * Server-side because it (a) avoids CORS, (b) lets us filter out low-liquidity
 * scam-of-the-hour tokens, (c) shapes the JSON:API response down to the few
 * fields the panel needs, and (d) KV-caches the result so GeckoTerminal's
 * keyless ~30 req/min budget is never the bottleneck regardless of traffic.
 * Holds no secrets. Mirrors the security posture of functions/api/intent.ts.
 */

interface Env {
  OPHIS_RATELIMIT?: KVNamespace
}

type ErrorCode = 'BAD_INPUT' | 'UNSUPPORTED' | 'UPSTREAM' | 'TIMEOUT' | 'RATE_LIMITED' | 'FORBIDDEN'

interface TrendingToken {
  symbol: string
  name: string
  address: string
  priceUsd: number
  change1h: number
  logo: string | null
}
type TrendingResponse =
  | { ok: true; data: { network: string; tokens: TrendingToken[] } }
  | { ok: false; error: { code: ErrorCode; message: string } }

/** GeckoTerminal network slug per chain. Unlisted chains return an empty list. */
const GECKO_NETWORK: Record<number, string> = {
  1: 'eth', 10: 'optimism', 56: 'bsc', 100: 'xdai', 137: 'polygon_pos',
  8453: 'base', 42161: 'arbitrum', 43114: 'avax', 57073: 'ink', 59144: 'linea',
}

const TIMEOUT_MS = 7000
const MAX_TOKENS = 6
const MIN_LIQUIDITY_USD = 20_000 // floor: keep "trending by real volume", not scams
const FRESH_MS = 300_000 // serve cached data without re-fetching upstream for this long (5 min): trending-by-1h-volume changes slowly, so this is the main lever for cutting GeckoTerminal 429s
const STALE_TTL_SECONDS = 3600 // keep last-good in KV up to 1h to ride out upstream rate-limits
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 90
// Best-effort, per-isolate (not global): the real DoS/cost protection is the 60s
// KV cache below — at most ~1 upstream fetch per chain per minute regardless of traffic.
const ipBuckets = new Map<string, number[]>()

// EVM token address; the FE uses this verbatim as a swap currency id, so anything
// that isn't a clean 0x-40hex is dropped (no garbage rows, no odd navigation target).
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
// Token logos may only come from CoinGecko/GeckoTerminal infra. The image_url field
// is attacker-controlled (anyone can list a token with a chosen image_url); pinning
// the host kills both the CSS/markup-injection risk and the third-party privacy beacon.
const LOGO_HOST_SUFFIXES = ['.coingecko.com', '.geckoterminal.com']

/** Return the logo URL only if it's an https URL on a trusted host; else null. */
export function safeLogoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('missing')) return null
  // Reject CSS/markup-dangerous characters up front: a real CDN logo URL never
  // contains them, and this keeps the value safe even if it's ever interpolated
  // somewhere other than an (already React-escaped) <img src>.
  if (/[\s"'`()<>\\;]/.test(raw)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username || u.password) return null // no userinfo: keep the effective host unambiguous
  const host = u.hostname.toLowerCase()
  // endsWith('.coingecko.com') is anchored: 'evilcoingecko.com' fails (no leading dot),
  // and new URL() parsing defeats the userinfo trick (host@evil.com -> hostname 'evil.com').
  if (!LOGO_HOST_SUFFIXES.some((s) => host.endsWith(s))) return null
  return u.toString()
}

const ALLOWED_ORIGINS = new Set<string>(['https://ophis.fi', 'https://swap.ophis.fi'])
const isAllowedOrigin = (o: string | null): boolean => !!o && ALLOWED_ORIGINS.has(o)

const json = (body: TrendingResponse, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  })

function rateLimit(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  if (ipBuckets.size > 1024) for (const k of Array.from(ipBuckets.keys()).slice(0, 200)) ipBuckets.delete(k)
  const recent = (ipBuckets.get(ip) ?? []).filter((t) => t >= cutoff)
  if (recent.length >= RATE_LIMIT_MAX) {
    ipBuckets.set(ip, recent)
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000)) }
  }
  recent.push(now)
  ipBuckets.set(ip, recent)
  return { ok: true }
}

/** Shape GeckoTerminal's JSON:API trending_pools response into our token list. */
export function parseTrending(raw: unknown): TrendingToken[] {
  // Total over any upstream shape: a non-object (null / primitive) yields [] rather
  // than throwing — the endpoint must fail soft, never 500, on a malformed response.
  const r = (raw && typeof raw === 'object' ? raw : {}) as {
    data?: Array<{
      attributes?: {
        base_token_price_usd?: string
        reserve_in_usd?: string
        price_change_percentage?: { h1?: string }
      }
      relationships?: { base_token?: { data?: { id?: string } } }
    }>
    included?: Array<{ id?: string; attributes?: { address?: string; symbol?: string; name?: string; image_url?: string } }>
  }
  const tokensById = new Map<string, { address: string; symbol: string; name: string; logo: string | null }>()
  for (const inc of r.included ?? []) {
    const a = inc.attributes
    if (inc.id && typeof a?.address === 'string' && ADDRESS_RE.test(a.address) && a.symbol) {
      // Coerce to string defensively: a non-string symbol/name would otherwise throw
      // at .slice() below and crash the whole request.
      const symbol = String(a.symbol)
      const name = a.name == null ? symbol : String(a.name)
      tokensById.set(inc.id, { address: a.address, symbol, name, logo: safeLogoUrl(a.image_url) })
    }
  }
  const out: TrendingToken[] = []
  const seen = new Set<string>()
  for (const pool of r.data ?? []) {
    const id = pool.relationships?.base_token?.data?.id
    const tok = id ? tokensById.get(id) : undefined
    if (!tok || seen.has(tok.address)) continue
    const price = Number(pool.attributes?.base_token_price_usd)
    const liq = Number(pool.attributes?.reserve_in_usd)
    const chg = Number(pool.attributes?.price_change_percentage?.h1)
    if (!Number.isFinite(price) || price <= 0) continue
    if (!Number.isFinite(liq) || liq < MIN_LIQUIDITY_USD) continue
    seen.add(tok.address)
    out.push({
      symbol: tok.symbol.slice(0, 12),
      name: tok.name.slice(0, 40),
      address: tok.address,
      priceUsd: price,
      change1h: Number.isFinite(chg) ? Math.round(chg * 100) / 100 : 0,
      logo: tok.logo,
    })
    if (out.length >= MAX_TOKENS) break
  }
  return out
}

/** Fetch + parse trending tokens for a network. Throws on any upstream/parse failure. */
async function fetchTrending(network: string): Promise<TrendingToken[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const upstream = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?include=base_token&page=1`,
      // A User-Agent is required: Workers send none by default, and GeckoTerminal's
      // edge intermittently rejects UA-less (bot-looking) requests.
      { signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'OphisSwap/1.0 (+https://ophis.fi)' } },
    )
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`)
    return parseTrending(await upstream.json())
  } finally {
    clearTimeout(timer)
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  // Absolute backstop: no code path may surface a platform 502. Any unexpected throw
  // (anywhere below, incl. the runtime) becomes a clean JSON error the panel fails soft on.
  try {
    return await handleTrending(context)
  } catch {
    return json({ ok: false, error: { code: 'UPSTREAM', message: 'trending temporarily unavailable' } }, 502)
  }
}

async function handleTrending(context: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  const { request, env } = context
  const origin = request.headers.get('origin')
  if (origin && !isAllowedOrigin(origin)) {
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'origin not allowed' } }, 403)
  }
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = rateLimit(ip)
  if (!rl.ok) {
    return json({ ok: false, error: { code: 'RATE_LIMITED', message: 'too many requests' } }, 429, {
      'retry-after': String(rl.retryAfterSec),
    })
  }

  const chainId = Number(new URL(request.url).searchParams.get('chainId'))
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'chainId must be a positive integer' } }, 400)
  }
  const network = GECKO_NETWORK[chainId]
  if (!network) return json({ ok: true, data: { network: '', tokens: [] } })

  // Stale-while-revalidate. GeckoTerminal's keyless API rate-limits Cloudflare's
  // SHARED egress IPs, so a naive TTL cache turns every transient upstream 429 (at the
  // moment the cache lapses) into a user-facing failure. Instead we serve last-good data
  // through upstream outages and only refresh in the background — a 429 becomes invisible.
  const cacheKey = `trend:${chainId}`
  let cached: { at: number; body: TrendingResponse } | null = null
  if (env.OPHIS_RATELIMIT) {
    try {
      const s = await env.OPHIS_RATELIMIT.get(cacheKey)
      if (s) cached = JSON.parse(s)
    } catch {
      // KV miss/outage/parse → treat as no cache.
    }
  }
  const now = Date.now()

  const persist = (body: TrendingResponse): void => {
    if (!env.OPHIS_RATELIMIT) return
    context.waitUntil(
      env.OPHIS_RATELIMIT.put(cacheKey, JSON.stringify({ at: now, body }), { expirationTtl: STALE_TTL_SECONDS }).catch(() => {}),
    )
  }

  // Fresh enough → serve straight from cache, no upstream call.
  if (cached && now - cached.at < FRESH_MS) return json(cached.body, 200, { 'x-ophis-cache': 'fresh' })

  // Stale or missing → refresh. parseTrending/fetch can throw; never let it escape.
  let tokens: TrendingToken[] | null = null
  try {
    tokens = await fetchTrending(network)
  } catch {
    tokens = null
  }

  if (tokens) {
    const body: TrendingResponse = { ok: true, data: { network, tokens } }
    persist(body)
    return json(body, 200, { 'x-ophis-cache': cached ? 'revalidated' : 'miss' })
  }

  // Refresh failed → ride out the outage on last-good data if we have it...
  if (cached) return json(cached.body, 200, { 'x-ophis-cache': 'stale' })
  // ...else cold + upstream down: empty list (panel hides), uncached so the next request retries.
  return json({ ok: true, data: { network, tokens: [] } }, 200, { 'x-ophis-cache': 'empty' })
}

export const onRequest: PagesFunction<Env> = ({ request }) =>
  json({ ok: false, error: { code: 'BAD_INPUT', message: `method ${request.method} not allowed` } }, 405)
