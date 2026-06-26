/**
 * Client-side GeckoTerminal trending-tokens fetch + parse.
 *
 * The panel used to call a CF Pages Function (/api/trending) that proxied
 * GeckoTerminal server-side. But GeckoTerminal's keyless API rate-limits
 * Cloudflare's SHARED egress IPs, so that server-side fetch is now persistently
 * throttled and returns an empty list -> the panel silently hides. GeckoTerminal
 * serves `access-control-allow-origin: *`, so we fetch it DIRECTLY from the
 * browser instead: each user hits it from their own residential IP (not the
 * blocked CF IP) with the browser's real User-Agent, keyless and free. The
 * security-critical bits — the host-pinned logo allow-list and the strict token
 * address validation (the address becomes a swap navigation target) — are ported
 * verbatim from the old function; the CSP already allows `connect-src https:` /
 * `img-src https:`, so nothing is loosened.
 */

export interface TrendingToken {
  symbol: string
  name: string
  address: string
  /** USD price of the base token. */
  priceUsd: number
  /** 1h price change in percent. */
  change1h: number
  logo: string | null
}

/** GeckoTerminal network slug per chain. Unlisted chains return an empty list. */
export const GECKO_NETWORK: Record<number, string> = {
  1: 'eth', 10: 'optimism', 56: 'bsc', 100: 'xdai', 137: 'polygon_pos',
  8453: 'base', 42161: 'arbitrum', 43114: 'avax', 57073: 'ink', 59144: 'linea',
}

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2'
const TIMEOUT_MS = 8000
const MAX_TOKENS = 6
const MIN_LIQUIDITY_USD = 20_000 // floor: keep "trending by real volume", not scams

// EVM token address; used verbatim as a swap currency id, so anything that isn't a
// clean 0x-40hex is dropped (no garbage rows, no odd navigation target).
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
// Token logos may only come from CoinGecko/GeckoTerminal infra. image_url is
// attacker-controlled (anyone can list a token with a chosen image_url); pinning the
// host kills both the markup/CSS-injection risk and the third-party privacy beacon.
const LOGO_HOST_SUFFIXES = ['.coingecko.com', '.geckoterminal.com']

/** Return the logo URL only if it's an https URL on a trusted host; else null. */
export function safeLogoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('missing')) return null
  // Reject markup/CSS-dangerous characters up front: a real CDN logo URL never
  // contains them, keeping the value safe even if it's ever used outside an <img src>.
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

/** Shape GeckoTerminal's JSON:API trending_pools response into our token list. */
export function parseTrending(raw: unknown): TrendingToken[] {
  // Total over any upstream shape: a non-object (null / primitive) yields [] rather
  // than throwing — parsing must fail soft, never crash, on a malformed response.
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
      // at .slice() below.
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

/**
 * Fetch + parse trending tokens for a GeckoTerminal network slug, from the browser.
 * Throws on any non-2xx / network / timeout failure so the caller can fail soft.
 * `referrerPolicy: no-referrer` + `credentials: omit` keep the swap URL and any
 * cookies away from GeckoTerminal (the one privacy cost of going client-side is the
 * user's IP, inherent to any browser request and consistent with the app's existing
 * third-party calls).
 */
export async function fetchTrending(network: string, externalSignal: AbortSignal): Promise<TrendingToken[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  externalSignal.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${GECKO_BASE}/networks/${network}/trending_pools?include=base_token&page=1`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!res.ok) throw new Error(`geckoterminal ${res.status}`)
    return parseTrending(await res.json())
  } finally {
    clearTimeout(timer)
    externalSignal.removeEventListener('abort', onAbort)
  }
}
