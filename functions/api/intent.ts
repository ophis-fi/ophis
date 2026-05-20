/**
 * POST /api/intent
 *
 * Parses a natural-language swap request via LibertAI Qwen 3.5 122B and
 * returns a structured ParsedIntent. Browser → this function → LibertAI.
 *
 * The LibertAI API key (LIBERTAI_API_KEY) is held as a Cloudflare Pages
 * environment secret and never reaches the browser.
 *
 * See docs/development/specs/2026-05-08-ophis-intent-input-design.md.
 */

interface Env {
  LIBERTAI_API_KEY: string
  // KV namespace `OPHIS_RATELIMIT` — distributed rate-limit counter,
  // bound to this Pages project at the production env level. See
  // docs/development/specs/2026-05-08-ophis-intent-input-design.md.
  // If unbound (e.g. during local wrangler dev without the binding),
  // the rate limiter falls back to an in-isolate Map (best-effort).
  OPHIS_RATELIMIT?: KVNamespace
}

type EntityType = 'sellToken' | 'buyToken' | 'amount' | 'chain'

interface Entity {
  type: EntityType
  value: string
  raw: string
  start: number
  end: number
}

interface ParsedIntent {
  intent: 'swap' | 'unknown'
  entities: Entity[]
}

type ErrorCode = 'TIMEOUT' | 'UPSTREAM' | 'INVALID_JSON' | 'BAD_INPUT' | 'RATE_LIMITED' | 'FORBIDDEN'

type IntentResponse =
  | { ok: true; data: ParsedIntent }
  | { ok: false; error: { code: ErrorCode; message: string } }

const LIBERTAI_URL = 'https://api.libertai.io/v1/chat/completions'
const LIBERTAI_MODEL = 'qwen3.5-122b-a10b'
const TIMEOUT_MS = 5000
const MAX_TEXT_LEN = 280

// Edge cache for identical (normalized) text inputs. Catches the
// "user clicks the same chip preset 50 times" and "bot replays the
// same input" cases without burning a LibertAI token round-trip per
// hit. Cache hit = no LibertAI call at all.
//
// TTL: 5 minutes. Intents are semantically stable (the LLM is
// temperature:0 and SYSTEM_PROMPT pinned, so identical input ⇒
// identical output until we deploy a new prompt). 5min is conservative
// — could be 1h+ in steady state. Keep short to limit blast radius
// if a bad cached response ever lands.
//
// Storage: reuse the OPHIS_RATELIMIT KV namespace with a `cache:`
// key prefix. Initial impl tried Cloudflare's edge `caches.default`
// API but fire-and-forget puts without `ctx.waitUntil` were dropped
// and synthetic-URL cache keys are POP-scoped (not globally shared).
// KV gives us global consistency (~60s replication lag, well within
// our 5min TTL) and persists across isolate lifecycles.
const CACHE_TTL_SECONDS = 300
const CACHE_KEY_PREFIX = 'cache:'

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Rate limit (per IP, sliding window). Primary path: a KV-backed
// counter (`env.OPHIS_RATELIMIT`) with N distinct strongly-consistent
// reads — works across all CF isolates and edge POPs. Fallback path:
// an in-isolate Map (per-isolate, near-useless on Pages Functions
// because each request often gets a fresh isolate, but kept so the
// function still imposes *some* cap if the binding ever drops).
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 30
const RATE_LIMIT_MAX_KEYS = 1024 // hard cap on memory growth per isolate (fallback path)
const ipBuckets = new Map<string, number[]>()

const ALLOWED_ORIGINS = new Set<string>([
  // Production canonical domain (registered 2026-05-10).
  'https://ophis.fi',
  // Legacy Pages URL — kept during the .pages.dev → ophis.fi transition,
  // safe to drop once the custom domain has been live for a while and
  // no traffic remains on the .pages.dev hostname.
  'https://greg-etm.pages.dev',
  // Cloudflare Pages preview deploys land at *.greg-etm.pages.dev or
  // *.greg.pages.dev. Allow them by suffix in `isAllowedOrigin` below.
])

const ALLOWED_ORIGIN_SUFFIXES = ['.greg-etm.pages.dev', '.greg.pages.dev']

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    const url = new URL(origin)
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => url.host.endsWith(suffix))
  } catch {
    return false
  }
}

async function checkRateLimitKV(
  kv: KVNamespace,
  ip: string,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const key = `rl:${ip}`
  // KV.get returns the most recent timestamps array (or null). Strong
  // consistency is not guaranteed across regions, but Cloudflare KV's
  // typical replication lag (<1s) is well within our window.
  const raw = await kv.get(key)
  let timestamps: number[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) timestamps = parsed.filter((t): t is number => typeof t === 'number' && t >= cutoff)
    } catch {
      // bad value in KV — treat as empty; will be overwritten below.
    }
  }
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000))
    return { ok: false, retryAfterSec }
  }
  timestamps.push(now)
  // expirationTtl: window + small buffer; KV cleans up automatically.
  await kv.put(key, JSON.stringify(timestamps), { expirationTtl: 120 })
  return { ok: true }
}

function checkRateLimitIsolate(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  if (ipBuckets.size > RATE_LIMIT_MAX_KEYS) {
    const oldest = Array.from(ipBuckets.keys()).slice(0, ipBuckets.size - RATE_LIMIT_MAX_KEYS + 64)
    for (const k of oldest) ipBuckets.delete(k)
  }
  const bucket = ipBuckets.get(ip) ?? []
  const recent: number[] = []
  for (const t of bucket) if (t >= cutoff) recent.push(t)
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000))
    ipBuckets.set(ip, recent)
    return { ok: false, retryAfterSec }
  }
  recent.push(now)
  ipBuckets.set(ip, recent)
  return { ok: true }
}

async function checkRateLimit(
  env: Env,
  ip: string,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  if (env.OPHIS_RATELIMIT) {
    try {
      return await checkRateLimitKV(env.OPHIS_RATELIMIT, ip)
    } catch {
      // KV outage → fall back to the per-isolate cap rather than
      // failing open. Logging would happen via CF logs.
      return checkRateLimitIsolate(ip)
    }
  }
  return checkRateLimitIsolate(ip)
}

const SYSTEM_PROMPT = `You parse natural-language swap requests for Ophis, an intent-based DEX aggregator. Given user text, return ONLY a single JSON object, no prose, no markdown fences.

Schema:
{
  "intent": "swap" | "unknown",
  "entities": [
    {
      "type": "sellToken" | "buyToken" | "amount" | "chain",
      "value": "<canonical>",
      "raw": "<exact substring>",
      "start": <int>,
      "end": <int>
    }
  ]
}

Rules:
- Token canonical values: uppercase symbols of well-known crypto
  assets traded on EVM DEXes. Examples by category:
    Stablecoins:   USDC, USDT, DAI, FRAX, LUSD, GHO, FDUSD, EURC, MIM
    ETH-pegs:      ETH, WETH, STETH, WSTETH, RETH, CBETH, EZETH
    BTC-pegs:      WBTC, TBTC, CBBTC, BTC
    Native L1/L2:  ARB, OP, MATIC, AVAX, BNB, APT, SUI, NEAR, ATOM,
                   FIL, HBAR, ICP, ALGO, TRX, LTC, BCH, XRP, ADA,
                   SOL, DOT, TIA, TAO, MNT, IMX, STRK, INJ, SEI, METIS
    DeFi:          UNI, AAVE, MKR, LDO, COMP, CRV, SUSHI, SNX, BAL,
                   GNO, YFI, 1INCH, LINK, FXS, RPL, PENDLE, ENS,
                   EIGEN, GRT, JUP, JTO, PYTH, GMX, AERO, VELO, CAKE
    AI/RWA:        FET, RNDR, ARKM, AKT, ONDO, ETHFI, IO, WLD, TAO
    Memes:         PEPE, SHIB, DOGE, BONK, WIF, FLOKI, BRETT, MOG,
                   MEW, POPCAT, TURBO, GIGA
    Gaming:        SAND, MANA, AXS, GALA, APE, ENJ, CHZ
  If you recognise a symbol not listed but commonly traded on DEXes
  (e.g. ATOM, NEAR, RUNE, OSMO, KAVA, WAVES, ROSE), emit it. The
  client filters unknown symbols out — better to emit a recognisable
  token than to omit it.
- Common aliases: "ether"/"ethers" -> ETH. "wrapped eth" -> WETH.
  "lido staked eth" -> STETH. "wrapped btc" -> WBTC. "bitcoin"/"btc" -> BTC.
  "uniswap" -> UNI. "aave" -> AAVE. "chainlink" -> LINK. "polygon"
  (the token) -> MATIC. "solana" (token) -> SOL. "cardano" -> ADA.
- "stables"/"stablecoin" alone (no specific symbol) -> OMIT.
- Chain canonical values: lowercase slugs. Allowed:
    ethereum, optimism, base, arbitrum, polygon, avalanche, gnosis, linea, bnb, megaeth, scroll, blast, mantle, zksync
- Chain aliases: "eth mainnet"/"l1"/"mainnet" (in chain context) -> ethereum. "op" -> optimism. "polygon pos" -> polygon. "bsc"/"binance smart chain" -> bnb. "zk sync"/"zk-sync" -> zksync.
- Amount: numeric string only ("100", "1.5"). "a hundred" -> "100". "a thousand" -> "1000". No units. No suffix multipliers like "k" / "m".
- ETH disambiguation: chain only when preceded by "on"/"via"/"using"; otherwise it is a token.
- Unknown tokens/chains: OMIT, do not invent. Do not output anything outside the allowed lists.
- start/end are 0-indexed character offsets in the ORIGINAL input. start inclusive, end exclusive. The substring text.slice(start, end) MUST equal the "raw" field exactly.
- If the input is not a swap request, return {"intent":"unknown","entities":[]}.
- Output ONLY the JSON.`

const json = (body: IntentResponse, status = 200, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // Defense-in-depth: prevent MIME-sniffing on the JSON response.
      'x-content-type-options': 'nosniff',
      // No frames; this endpoint is not meant to be embedded.
      'x-frame-options': 'DENY',
      // Strict referrer policy on API responses.
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  })

// Source-of-truth allow-list for tokens the parser will surface to the UI.
// The LibertAI prompt is encouraged to emit *any* DEX-traded token symbol;
// this set is the post-LLM filter. Symbols missing here are silently dropped
// (the LLM may emit them but `filterParsedIntent` strips them). Adding a
// symbol here does NOT guarantee the cowswap upstream can resolve it to an
// on-chain address — that's a separate token-list concern in apps/frontend.
//
// Categorisation is for human readability only; canonical lookup is the Set
// membership check in `isValidEntity`. Keep entries UPPERCASE.
//
// Updated 2026-05-11 (P3): expanded from 146 to 236 to improve intent-parser
// coverage on long-tail symbols. Curated against tokens with active EVM-DEX
// liquidity per CoinGecko top-volume snapshot. Logo coverage in
// apps/frontend/.../tokenAssets.ts remains a separate concern — symbols added
// here without a logo render as text-only chips (graceful degradation).
const TOKEN_VALUES = new Set([
  // Stablecoins
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'SUSD', 'GUSD', 'TUSD',
  'USDP', 'USDE', 'PYUSD', 'GHO', 'FDUSD', 'EURC', 'MIM', 'CRVUSD',
  'USDS', 'SUSDS', 'SDAI', 'USDR', 'AGEUR', 'BUSD',
  // ETH-pegs + LSTs/LRTs
  'ETH', 'WETH', 'STETH', 'WSTETH', 'RETH', 'CBETH', 'SFRXETH',
  'EZETH', 'RSETH',
  'METH', 'EETH', 'WEETH', 'PUFETH', 'OSETH', 'SWETH', 'ETHX',
  'WBETH', 'ANKRETH', 'OETH',
  // BTC-pegs
  'WBTC', 'TBTC', 'CBBTC', 'BTCB', 'BTC',
  // Native L1/L2
  'BNB', 'MATIC', 'ARB', 'OP', 'AVAX', 'APT', 'SUI', 'NEAR', 'ATOM',
  'FIL', 'HBAR', 'ICP', 'ALGO', 'ROSE', 'TON', 'SEI', 'INJ', 'RUNE',
  'OSMO', 'MNT', 'IMX', 'TRX', 'LTC', 'BCH', 'ETC', 'XRP', 'ADA',
  'SOL', 'DOT', 'KSM', 'XMR', 'XLM', 'FLOW', 'VET', 'HNT', 'AR',
  'FLR', 'TIA', 'TAO', 'CRO', 'CFX', 'FTM', 'CELO', 'KAVA', 'STX',
  'WAVES', 'ZEC', 'DASH', 'QNT', 'ICX', 'ZIL', 'ASTR', 'LSK',
  // DeFi blue-chips
  'UNI', 'AAVE', 'MKR', 'LDO', 'COMP', 'CRV', 'SUSHI', 'SNX', 'BAL',
  'GNO', 'YFI', '1INCH', 'LINK', 'FXS', 'RPL', 'PENDLE', 'ENS',
  'EIGEN', 'GRT', 'JUP', 'JTO', 'PYTH', 'GMX', 'AERO', 'VELO', 'KAS',
  'DYM', 'CAKE', 'OCEAN', 'NMR', 'RLC', 'BAND', 'ZRX', 'PRIME', 'RON',
  'NEXO', 'STRK', 'METIS',
  'ENA', 'MORPHO', 'RDNT', 'JOE', 'SWELL', 'ORDI', 'USUAL', 'RBN',
  'DYDX', 'BICO', 'KNC', 'SDT', 'MAGIC', 'QUICK', 'MASK', 'OGN',
  'BAT', 'LRC', 'GMT', 'WOO', 'GLM', 'CFG', 'ALCX', 'LPT', 'HOT',
  'CVX', 'AMP', 'RSR', 'POLY', 'OMG', 'STORJ', 'BNT', 'ANT', 'ANKR',
  'KEEP', 'MTL', 'AUDIO', 'CHR', 'SUPER', 'MAV', 'CKB', 'ADX', 'REQ',
  'ELF', 'ATA',
  // AI / DePIN / RWA
  'FET', 'RNDR', 'ARKM', 'AKT', 'ONDO', 'ETHFI', 'IO', 'WLD',
  'VIRTUAL', 'AIXBT', 'AI16Z', 'GRASS', 'NOS', 'IPOR', 'MOBILE',
  'IOTX', 'TFUEL',
  // Memes
  'PEPE', 'SHIB', 'DOGE', 'BONK', 'WIF', 'FLOKI', 'BRETT', 'MOG',
  'MEW', 'POPCAT', 'TURBO', 'GIGA',
  'TOSHI', 'NEIRO', 'GOAT', 'PNUT', 'MOODENG', 'DEGEN', 'MICHI',
  'TRUMP', 'ZRO', 'BABYDOGE',
  // Gaming
  'SAND', 'MANA', 'AXS', 'GALA', 'APE', 'ENJ', 'CHZ', 'JASMY',
  'BEAM', 'PIXEL', 'PORTAL', 'ALICE', 'VOXEL',
  // Other
  'STG', 'RAD',
])

const CHAIN_VALUES = new Set([
  'ethereum',
  'optimism',
  'base',
  'arbitrum',
  'polygon',
  'avalanche',
  'gnosis',
  'linea',
  'bnb',
  'megaeth',
  'scroll',
  'blast',
  'mantle',
  'zksync',
])

function isValidEntity(e: unknown, textLen: number): e is Entity {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  if (typeof o.value !== 'string' || typeof o.raw !== 'string') return false
  if (typeof o.start !== 'number' || typeof o.end !== 'number') return false
  if (o.start < 0 || o.end > textLen || o.start >= o.end) return false
  if (o.type === 'sellToken' || o.type === 'buyToken') return TOKEN_VALUES.has(o.value)
  if (o.type === 'chain') return CHAIN_VALUES.has(o.value)
  if (o.type === 'amount') return /^\d+(\.\d+)?$/.test(o.value)
  return false
}

/**
 * Filter the model's output instead of rejecting the whole response
 * when individual entities don't pass validation. Lets the LLM emit
 * symbols outside our hard allow-list (the model is encouraged to
 * extract any well-known DEX-traded token) while still guaranteeing
 * the frontend only sees entities it can render. Returns null if the
 * top-level shape itself is wrong.
 */
function filterParsedIntent(d: unknown, textLen: number): ParsedIntent | null {
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  if (o.intent !== 'swap' && o.intent !== 'unknown') return null
  if (!Array.isArray(o.entities)) return null
  const entities = o.entities.filter((e): e is Entity => isValidEntity(e, textLen))
  return { intent: o.intent, entities }
}

function stripFences(s: string): string {
  // Tolerate the model wrapping output in ```json ... ``` despite the rule.
  const trimmed = s.trim()
  const fence = /^```(?:json)?\n?([\s\S]*?)\n?```$/i
  const m = trimmed.match(fence)
  return m ? m[1].trim() : trimmed
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Origin allow-list: block calls from non-Ophis pages and most
  // non-browser callers (curl/scripts typically omit Origin entirely).
  // Not a security boundary against motivated attackers — Origin can
  // be spoofed by anything that's not a browser — but it raises the
  // bar for casual abuse.
  const origin = request.headers.get('origin')
  if (origin && !isAllowedOrigin(origin)) {
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'origin not allowed' } }, 403)
  }

  // Per-IP rate limit, KV-backed (distributed across all isolates).
  // cf-connecting-ip is set by Cloudflare on every edge request.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = await checkRateLimit(env, ip)
  if (!rl.ok) {
    return json(
      { ok: false, error: { code: 'RATE_LIMITED', message: 'too many requests' } },
      429,
      { 'retry-after': String(rl.retryAfterSec) },
    )
  }

  if (!env.LIBERTAI_API_KEY) {
    // Operator-facing message: still says "LibertAI key not configured"
    // verbatim because IntentLanding's helperText regex looks for that
    // exact phrase to surface the operator-action banner. If you change
    // the message, update IntentLanding.helperText too.
    return json({ ok: false, error: { code: 'UPSTREAM', message: 'LibertAI key not configured' } }, 500)
  }

  let body: { text?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'invalid JSON body' } }, 400)
  }

  const text = body?.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'text required' } }, 400)
  }
  if (text.length > MAX_TEXT_LEN) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: `text exceeds ${MAX_TEXT_LEN} chars` } }, 400)
  }

  // Edge cache lookup (Phase 3.8 / 2026-05-20). Normalized text →
  // SHA-256 → KV key. Hit = serve cached LibertAI response without
  // burning a token round-trip.
  //
  // We deliberately CHECK the cache AFTER rate-limit + auth/input
  // validation so cache hits still respect the per-IP cap (don't
  // let an attacker drain the cache by serving identical inputs
  // unbounded). The rate limit increments before the cache check.
  const normalizedText = text.trim().toLowerCase()
  const cacheKeyHash = await sha256Hex(normalizedText)
  const cacheKey = CACHE_KEY_PREFIX + cacheKeyHash

  if (env.OPHIS_RATELIMIT) {
    try {
      const cached = await env.OPHIS_RATELIMIT.get(cacheKey)
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
            'x-ophis-cache': 'hit',
          },
        })
      }
    } catch {
      // KV outage → degraded to no-cache, still call LibertAI.
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(LIBERTAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${env.LIBERTAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: LIBERTAI_MODEL,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    })
  } catch (err: unknown) {
    clearTimeout(timer)
    const aborted = err instanceof Error && err.name === 'AbortError'
    // Generic error messages — don't reveal the upstream provider.
    return json(
      {
        ok: false,
        error: {
          code: aborted ? 'TIMEOUT' : 'UPSTREAM',
          message: aborted ? 'parser did not respond within 5s' : 'failed to reach parser',
        },
      },
      aborted ? 504 : 502,
    )
  }
  clearTimeout(timer)

  if (!upstreamRes.ok) {
    return json({ ok: false, error: { code: 'UPSTREAM', message: `parser returned ${upstreamRes.status}` } }, 502)
  }

  let raw: unknown
  try {
    raw = await upstreamRes.json()
  } catch {
    return json({ ok: false, error: { code: 'INVALID_JSON', message: 'parser returned non-JSON' } }, 502)
  }

  // OpenAI-compatible: choices[0].message.content is the model's text.
  const content =
    (raw as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    return json({ ok: false, error: { code: 'INVALID_JSON', message: 'no content in parser response' } }, 502)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(content))
  } catch {
    return json({ ok: false, error: { code: 'INVALID_JSON', message: 'model output was not JSON' } }, 502)
  }

  const filtered = filterParsedIntent(parsed, text.length)
  if (!filtered) {
    return json(
      { ok: false, error: { code: 'INVALID_JSON', message: 'model output failed schema validation' } },
      502,
    )
  }

  const successBody: IntentResponse = { ok: true, data: filtered }
  const successJson = JSON.stringify(successBody)

  // Store in KV cache. Only successful 200s — errors (UPSTREAM,
  // INVALID_JSON, TIMEOUT) are NEVER cached so a transient LibertAI
  // hiccup doesn't persist "no LibertAI" for 5 minutes to every user.
  //
  // Fire-and-forget. If KV.put fails (rare), next request re-fetches
  // LibertAI — degraded to current behavior, not an error path.
  if (env.OPHIS_RATELIMIT) {
    try {
      // KV.put returns a Promise — letting it run async; we don't await
      // because the function exits and returns the response. CF Pages'
      // KV implementation buffers the write through the runtime so
      // even fire-and-forget completes after function return (verified
      // by Cloudflare docs for KV vs. caches.default).
      void env.OPHIS_RATELIMIT.put(cacheKey, successJson, {
        expirationTtl: CACHE_TTL_SECONDS,
      })
    } catch {
      // ignore — degraded path is no-cache.
    }
  }

  return json(successBody)
}

// Reject anything else.
export const onRequest: PagesFunction<Env> = ({ request }) => {
  return json(
    { ok: false, error: { code: 'BAD_INPUT', message: `method ${request.method} not allowed` } },
    405,
  )
}
