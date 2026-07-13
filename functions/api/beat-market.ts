/**
 * POST /api/beat-market
 *
 * Returns a reference all-DEX (KyberSwap) sell quote for a token pair so the
 * trade widget can show "you save ~X bps vs the best DEX-aggregator route".
 * Browser → this function → KyberSwap.
 *
 * Server-side because KyberSwap 403s a browser User-Agent and serves no CORS
 * headers, so the FE cannot call it directly. This proxy sets a browser-like
 * UA and returns only the single number the widget needs (the reference
 * amountOut), never the full route. Holds no secrets; KyberSwap's aggregator
 * API is itself keyless and public.
 *
 * Mirrors the security posture of functions/api/intent.ts: origin allow-list,
 * per-IP Cloudflare Rate Limiting binding (isolate fallback), bounded upstream timeout, generic
 * errors, no-store.
 */

interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

interface Env {
  /** Cloudflare Rate Limiting binding for authoritative per-IP admission. */
  OPHIS_BEAT_MARKET_RATE_LIMITER?: RateLimitBinding
}

type ErrorCode = 'BAD_INPUT' | 'UNSUPPORTED' | 'UPSTREAM' | 'TIMEOUT' | 'RATE_LIMITED' | 'FORBIDDEN'

type BeatMarketResponse =
  | { ok: true; data: { source: 'kyberswap'; amountOut: string } }
  | { ok: false; error: { code: ErrorCode; message: string } }

// KyberSwap aggregator path-slug per chain. Only chains KyberSwap serves; an
// unlisted chain returns UNSUPPORTED (the widget just hides the number) rather
// than erroring. Mirrors KYBER_SLUG in apps/mcp-server/src/ophis.ts.
const KYBER_SLUG: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
}

const TIMEOUT_MS = 6000
const MAX_AMOUNT_LEN = 80 // a uint256 in decimal is at most 78 digits

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 60
const RATE_LIMIT_MAX_KEYS = 1024
const ipBuckets = new Map<string, number[]>()

const ALLOWED_ORIGINS = new Set<string>(['https://ophis.fi', 'https://swap.ophis.fi'])

function isAllowedOrigin(origin: string | null): boolean {
  return !!origin && ALLOWED_ORIGINS.has(origin)
}

const json = (body: BeatMarketResponse, status = 200, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  })

function checkRateLimitIsolate(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  if (ipBuckets.size > RATE_LIMIT_MAX_KEYS) {
    for (const k of Array.from(ipBuckets.keys()).slice(0, ipBuckets.size - RATE_LIMIT_MAX_KEYS + 64)) ipBuckets.delete(k)
  }
  const recent = (ipBuckets.get(ip) ?? []).filter((t) => t >= cutoff)
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    ipBuckets.set(ip, recent)
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000)) }
  }
  recent.push(now)
  ipBuckets.set(ip, recent)
  return { ok: true }
}

async function checkRateLimit(env: Env, ip: string): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  if (env.OPHIS_BEAT_MARKET_RATE_LIMITER) {
    try {
      const result = await env.OPHIS_BEAT_MARKET_RATE_LIMITER.limit({ key: ip })
      return result.success ? { ok: true } : { ok: false, retryAfterSec: 60 }
    } catch {
      return checkRateLimitIsolate(ip)
    }
  }
  return checkRateLimitIsolate(ip)
}

const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
const isAtoms = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9]+$/.test(v) && v.length <= MAX_AMOUNT_LEN && v !== '0'

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  const origin = request.headers.get('origin')
  if (origin && !isAllowedOrigin(origin)) {
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'origin not allowed' } }, 403)
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = await checkRateLimit(env, ip)
  if (!rl.ok) {
    return json({ ok: false, error: { code: 'RATE_LIMITED', message: 'too many requests' } }, 429, {
      'retry-after': String(rl.retryAfterSec),
    })
  }

  let body: { chainId?: unknown; sellToken?: unknown; buyToken?: unknown; sellAmount?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'invalid JSON body' } }, 400)
  }

  const { chainId, sellToken, buyToken, sellAmount } = body
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'chainId must be a positive integer' } }, 400)
  }
  if (!isAddress(sellToken) || !isAddress(buyToken)) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'sellToken/buyToken must be 0x addresses' } }, 400)
  }
  if (!isAtoms(sellAmount)) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'sellAmount must be a positive integer string of atoms' } }, 400)
  }

  const slug = KYBER_SLUG[chainId]
  if (!slug) {
    return json({ ok: false, error: { code: 'UNSUPPORTED', message: `no reference aggregator for chain ${chainId}` } }, 200)
  }

  const url = `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?tokenIn=${sellToken}&tokenOut=${buyToken}&amountIn=${sellAmount}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let upstream: Response
  try {
    upstream = await fetch(url, {
      signal: controller.signal,
      // KyberSwap 403s the default fetch UA; send a browser-like one.
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) ophis-beat-market', accept: 'application/json' },
    })
  } catch (err: unknown) {
    clearTimeout(timer)
    const aborted = err instanceof Error && err.name === 'AbortError'
    return json(
      { ok: false, error: { code: aborted ? 'TIMEOUT' : 'UPSTREAM', message: aborted ? 'reference timed out' : 'failed to reach reference' } },
      aborted ? 504 : 502,
    )
  }
  clearTimeout(timer)

  if (!upstream.ok) {
    return json({ ok: false, error: { code: 'UPSTREAM', message: `reference returned ${upstream.status}` } }, 502)
  }

  let raw: unknown
  try {
    raw = await upstream.json()
  } catch {
    return json({ ok: false, error: { code: 'UPSTREAM', message: 'reference returned non-JSON' } }, 502)
  }

  const amountOut = (raw as { data?: { routeSummary?: { amountOut?: unknown } } })?.data?.routeSummary?.amountOut
  // Length-cap the upstream value too (symmetric with the inbound sellAmount cap):
  // a misbehaving / compromised KyberSwap returning a megabyte-long all-digit
  // string would otherwise flow through to a heavy client-side BigInt parse.
  if (typeof amountOut !== 'string' || !/^[0-9]+$/.test(amountOut) || amountOut.length > MAX_AMOUNT_LEN) {
    // No route / unexpected shape: not an error the widget should toast — just
    // no reference available, so the savings line hides.
    return json({ ok: false, error: { code: 'UPSTREAM', message: 'no reference route available' } }, 200)
  }

  return json({ ok: true, data: { source: 'kyberswap', amountOut } })
}

// Reject anything else.
export const onRequest: PagesFunction<Env> = ({ request }) =>
  json({ ok: false, error: { code: 'BAD_INPUT', message: `method ${request.method} not allowed` } }, 405)
