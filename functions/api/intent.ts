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

type IntentResponse =
  | { ok: true; data: ParsedIntent }
  | { ok: false; error: { code: 'TIMEOUT' | 'UPSTREAM' | 'INVALID_JSON' | 'BAD_INPUT'; message: string } }

const LIBERTAI_URL = 'https://api.libertai.io/v1/chat/completions'
const LIBERTAI_MODEL = 'qwen3.5-122b-a10b'
const TIMEOUT_MS = 5000
const MAX_TEXT_LEN = 280

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

const json = (body: IntentResponse, status = 200): Response =>
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
