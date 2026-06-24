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
const CACHE_TTL_SECONDS = 60
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
export function safeLogoUrl(raw: string | undefined): string | null {
  if (!raw || raw.includes('missing')) return null
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
    if (inc.id && a?.address && ADDRESS_RE.test(a.address) && a.symbol) {
      tokensById.set(inc.id, { address: a.address, symbol: a.symbol, name: a.name ?? a.symbol, logo: safeLogoUrl(a.image_url) })
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

export const onRequestGet: PagesFunction<Env> = async (context) => {
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

  // KV cache (60s) — reuse the OPHIS_RATELIMIT namespace with a `trend:` prefix.
  const cacheKey = `trend:${chainId}`
  if (env.OPHIS_RATELIMIT) {
    try {
      const cached = await env.OPHIS_RATELIMIT.get(cacheKey)
      if (cached) return new Response(cached, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-ophis-cache': 'hit' } })
    } catch {
      // KV outage → fall through to a live fetch.
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let upstream: Response
  try {
    upstream = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?include=base_token&page=1`,
      { signal: controller.signal, headers: { accept: 'application/json' } },
    )
  } catch (err: unknown) {
    clearTimeout(timer)
    const aborted = err instanceof Error && err.name === 'AbortError'
    return json({ ok: false, error: { code: aborted ? 'TIMEOUT' : 'UPSTREAM', message: aborted ? 'trending timed out' : 'failed to reach trending source' } }, aborted ? 504 : 502)
  }
  clearTimeout(timer)
  if (!upstream.ok) return json({ ok: false, error: { code: 'UPSTREAM', message: `trending source returned ${upstream.status}` } }, 502)

  let raw: unknown
  try {
    raw = await upstream.json()
  } catch {
    return json({ ok: false, error: { code: 'UPSTREAM', message: 'trending source returned non-JSON' } }, 502)
  }

  const body: TrendingResponse = { ok: true, data: { network, tokens: parseTrending(raw) } }
  const out = JSON.stringify(body)
  if (env.OPHIS_RATELIMIT) {
    try {
      await env.OPHIS_RATELIMIT.put(cacheKey, out, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // best-effort cache write
    }
  }
  return new Response(out, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

export const onRequest: PagesFunction<Env> = ({ request }) =>
  json({ ok: false, error: { code: 'BAD_INPUT', message: `method ${request.method} not allowed` } }, 405)
