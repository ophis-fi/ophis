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

// Rate limit (per IP, per isolate) — sliding window. The cap below
// fits a normal user (typing ~10 phrases per minute, debounced 400 ms
// → ~10 calls/min); abusers spamming the endpoint get 429s after the
// first window. Caveat: Cloudflare Pages Functions run in isolates
// that are not 1:1 with users, so an attacker hitting different edge
// POPs can bypass each isolate's view. Provides best-effort throttling
// without standing up a KV namespace; upgrade to a KV-backed bucket
// once abuse is observed.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 30
const RATE_LIMIT_MAX_KEYS = 1024 // hard cap on memory growth per isolate
const ipBuckets = new Map<string, number[]>()

const ALLOWED_ORIGINS = new Set<string>([
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

function checkRateLimit(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  // Lazy GC: cap the map size to bound per-isolate memory.
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
- Token canonical values: uppercase symbols. Allowed:
    Stablecoins:   USDC, USDT, DAI, FRAX, LUSD, SUSD, GUSD, TUSD, USDP, USDE, PYUSD
    ETH-pegs:      ETH, WETH, STETH, WSTETH, RETH, CBETH, SFRXETH, EZETH, RSETH
    BTC-pegs:      WBTC, TBTC, CBBTC, BTCB
    Blue-chips:    UNI, AAVE, MKR, LDO, COMP, CRV, SUSHI, SNX, BAL, GNO, YFI, 1INCH, LINK, FXS, RPL, PENDLE, ENS
    Native gov:    MATIC, ARB, OP, AVAX, BNB
    Memes:         PEPE, SHIB, DOGE, BONK
- Common aliases: "ether"/"ethers" -> ETH. "wrapped eth" -> WETH. "lido staked eth" -> STETH. "wrapped btc" -> WBTC. "uniswap" -> UNI. "aave" -> AAVE. "chainlink" -> LINK. "polygon" (the token) -> MATIC.
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

const TOKEN_VALUES = new Set([
  // Stablecoins
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'SUSD', 'GUSD', 'TUSD', 'USDP', 'USDE', 'PYUSD',
  // ETH-pegs
  'ETH', 'WETH', 'STETH', 'WSTETH', 'RETH', 'CBETH', 'SFRXETH', 'EZETH', 'RSETH',
  // BTC-pegs
  'WBTC', 'TBTC', 'CBBTC', 'BTCB',
  // Blue-chips
  'UNI', 'AAVE', 'MKR', 'LDO', 'COMP', 'CRV', 'SUSHI', 'SNX', 'BAL', 'GNO', 'YFI', '1INCH',
  'LINK', 'FXS', 'RPL', 'PENDLE', 'ENS',
  // Native gov
  'MATIC', 'ARB', 'OP', 'AVAX', 'BNB',
  // Memes
  'PEPE', 'SHIB', 'DOGE', 'BONK',
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

function isValidParsedIntent(d: unknown, textLen: number): d is ParsedIntent {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  if (o.intent !== 'swap' && o.intent !== 'unknown') return false
  if (!Array.isArray(o.entities)) return false
  return o.entities.every((e) => isValidEntity(e, textLen))
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

  // Per-IP rate limit. cf-connecting-ip is set by Cloudflare on every
  // request. Falls back to an ip-less bucket if the header is missing
  // (which would be unusual on the CF edge).
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = checkRateLimit(ip)
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

  if (!isValidParsedIntent(parsed, text.length)) {
    return json(
      { ok: false, error: { code: 'INVALID_JSON', message: 'model output failed schema validation' } },
      502,
    )
  }

  return json({ ok: true, data: parsed })
}

// Reject anything else.
export const onRequest: PagesFunction<Env> = ({ request }) => {
  return json(
    { ok: false, error: { code: 'BAD_INPUT', message: `method ${request.method} not allowed` } },
    405,
  )
}
