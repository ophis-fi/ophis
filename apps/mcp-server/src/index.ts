/**
 * Ophis MCP server (Cloudflare Worker, Streamable HTTP at /mcp).
 *
 * Agent-facing tools for the Ophis DEX:
 *   parse_intent  — natural language -> structured swap intent (LibertAI Qwen)
 *   get_quote     — best-execution quote from the chain's Ophis orderbook
 *   build_order   — a bounded, ready-to-sign EIP-712 CoW order (receiver pinned)
 *   submit_order  — relay a PRE-SIGNED order to the orderbook (no keys held here)
 *   lookup_tier   — a wallet's fee-rebate tier/status
 *   list_chains   — supported chains + orderbook host + settlement contract
 *
 * The server holds NO private keys and never signs. build_order returns a
 * payload the calling agent signs with its own key. Public + unauthenticated:
 * every backing endpoint is already public, and the tools are read/build-only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'

import { registerOphisTools, SERVER_INFO } from './tools.js'

/** Cloudflare Workers rate-limit binding (unsafe.bindings type "ratelimit"). */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

interface Env {
  OPHIS_MCP: DurableObjectNamespace
  MCP_RATE_LIMIT?: RateLimit
  /** Optional server-wide default affiliate referral code. When set, build_order
   *  embeds it in appData unless the call passes its own referrerCode. Lets an
   *  operator attribute every order from their MCP instance to their own code. */
  OPHIS_DEFAULT_REFERRER_CODE?: string
  /** Rebate-indexer base URL. submit_order pings {base}/tier/<owner> to register
   *  a referrer-tagged order's owner for indexing (so the affiliate is actually
   *  credited). Defaults to the production indexer. */
  OPHIS_REBATES_API?: string
}

export class OphisMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer(SERVER_INFO)

  async init() {
    registerOphisTools(this.server, {
      defaultReferrerCode: this.env.OPHIS_DEFAULT_REFERRER_CODE,
      rebatesApi: this.env.OPHIS_REBATES_API,
    })
  }
}

const INFO = {
  name: 'Ophis MCP',
  description: 'Agent-facing tools for the Ophis DEX: parse swap intents, fetch quotes, build bounded signable CoW orders, submit signed orders, look up fee-rebate tiers.',
  transport: { type: 'streamable-http', endpoint: '/mcp' },
  tools: ['parse_intent', 'get_quote', 'build_order', 'submit_order', 'lookup_tier', 'list_chains'],
  docs: 'https://docs.ophis.fi/',
  source: 'https://github.com/ophis-fi/ophis',
  security:
    'Holds no private keys. The order receiver is unconditionally pinned to the owner (no custom-receiver option is exposed): build_order only builds owner-receiver orders and submit_order refuses to relay any non-owner-receiver order. The agent signs locally.',
} as const

// Abuse caps for the public, unauthenticated endpoint (audit finding #1/#2):
// the agents SDK forwards a JSON-RPC batch array bounded only by 4 MiB, so one
// POST could fan out to thousands of upstream LLM/orderbook hits. Cap the batch
// size and total body, and rate-limit per IP, BEFORE delegating to the transport.
const MAX_BATCH = 8
const MAX_BODY_BYTES = 256 * 1024
const RATE_KEY_FALLBACK = 'anon'

function rpcError(httpStatus: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status: httpStatus })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') return Response.json({ status: 'ok' })
    if (url.pathname === '/' || url.pathname === '/.well-known/mcp') {
      return Response.json(INFO, { headers: { 'cache-control': 'public, max-age=300' } })
    }

    // RFC 9116 disclosure path (mcp.ophis.fi is a Worker, not a Pages static host).
    if (url.pathname === '/.well-known/security.txt') {
      return new Response(
        [
          '# Ophis security disclosure',
          '# Full policy: https://github.com/ophis-fi/ophis/blob/main/SECURITY.md',
          'Contact: mailto:clement@aleph.cloud',
          'Expires: 2027-06-05T00:00:00.000Z',
          'Preferred-Languages: en',
          'Canonical: https://mcp.ophis.fi/.well-known/security.txt',
          'Policy: https://github.com/ophis-fi/ophis/blob/main/SECURITY.md',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } },
      )
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      // Per-IP rate limit (per-colo, best-effort) — caps brute abuse of the
      // public proxy; combined with the batch cap below it closes the
      // one-POST-to-many-upstream-calls amplification path.
      const ip = request.headers.get('cf-connecting-ip') ?? RATE_KEY_FALLBACK
      if (env.MCP_RATE_LIMIT) {
        const { success } = await env.MCP_RATE_LIMIT.limit({ key: ip })
        if (!success) return rpcError(429, -32000, 'Rate limit exceeded — slow down.')
      }

      if (request.method === 'POST') {
        const body = await request.text()
        if (body.length > MAX_BODY_BYTES) {
          return rpcError(413, -32600, `Request body exceeds ${MAX_BODY_BYTES} bytes.`)
        }
        try {
          const parsed = JSON.parse(body)
          if (Array.isArray(parsed) && parsed.length > MAX_BATCH) {
            return rpcError(429, -32600, `JSON-RPC batch too large (max ${MAX_BATCH} requests per call).`)
          }
        } catch {
          // Malformed JSON — let the MCP transport return the proper parse error.
        }
        // The body stream is consumed above; hand the transport an equivalent request.
        const rebuilt = new Request(request.url, { method: 'POST', headers: request.headers, body })
        return OphisMCP.serve('/mcp', { binding: 'OPHIS_MCP' }).fetch(rebuilt, env, ctx)
      }

      return OphisMCP.serve('/mcp', { binding: 'OPHIS_MCP' }).fetch(request, env, ctx)
    }

    return new Response('Not found. MCP endpoint: /mcp', { status: 404 })
  },
}
