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
import { z } from 'zod'

import {
  parseIntent,
  getQuote,
  buildOrder,
  submitOrder,
  lookupTier,
  listChains,
  type Address,
} from './ophis.js'

/** Cloudflare Workers rate-limit binding (unsafe.bindings type "ratelimit"). */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

interface Env {
  OPHIS_MCP: DurableObjectNamespace
  MCP_RATE_LIMIT?: RateLimit
}

const SERVER_INFO = { name: 'ophis', version: '0.0.1' } as const

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}
function fail(e: unknown) {
  const msg = (e as Error)?.message ?? String(e)
  const capped = msg.length > 500 ? msg.slice(0, 500) + '…' : msg
  return { content: [{ type: 'text' as const, text: `Error: ${capped}` }], isError: true }
}

export class OphisMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer(SERVER_INFO)

  async init() {
    this.server.registerTool(
      'parse_intent',
      {
        description:
          'Parse a plain-English swap request (e.g. "swap 100 USDC for ETH on Optimism") into a structured intent: { intent: "swap"|"unknown", entities: [{type: sellToken|buyToken|amount|chain, value, raw}] }. Backed by the live Ophis parser.',
        inputSchema: { text: z.string().min(1).max(280).describe('The natural-language swap request.') },
      },
      async ({ text }) => {
        try {
          return ok(await parseIntent(text))
        } catch (e) {
          return fail(e)
        }
      },
    )

    this.server.registerTool(
      'get_quote',
      {
        description:
          "Fetch a best-execution quote from the chain's Ophis orderbook (use a chainId from list_chains' `tradeable`). Amounts are in atoms (smallest unit, uint256 decimal string). For kind='sell' the amount is the sell amount before fee; for kind='buy' it is the desired buy amount. Returns the orderbook quote (sellAmount/buyAmount/feeAmount/validTo). Before build_order, apply slippage to the limit side by kind: kind='sell' -> lower buyAmount (min out); kind='buy' -> raise sellAmount (max in).",
        inputSchema: {
          chainId: z.number().int().describe('EVM chain id (use list_chains for supported chains).'),
          sellToken: z.string().describe('Sell token address (0x...).'),
          buyToken: z.string().describe('Buy token address (0x...).'),
          kind: z.enum(['sell', 'buy']),
          amount: z.string().describe('Amount in atoms (uint256 decimal string).'),
          from: z.string().describe('The trading account address (quotes are account-aware).'),
          validForSeconds: z.number().int().positive().optional(),
        },
      },
      async (a) => {
        try {
          return ok(
            await getQuote({
              chainId: a.chainId,
              sellToken: a.sellToken as Address,
              buyToken: a.buyToken as Address,
              kind: a.kind,
              amount: a.amount,
              from: a.from as Address,
              validForSeconds: a.validForSeconds,
            }),
          )
        } catch (e) {
          return fail(e)
        }
      },
    )

    this.server.registerTool(
      'build_order',
      {
        description:
          "Build a bounded, ready-to-sign CoW order on Ophis. Returns { order, signing:{domain,types,primaryType}, fullAppData, appDataHash, partnerFee, next }. The receiver is PINNED to the owner (proceeds cannot leave the account) unless unsafeCustomReceiver is set. Uses the correct per-chain settlement contract (Optimism/MegaETH/HyperEVM are non-canonical) and embeds the CIP-75 partner fee. Apply slippage to the LIMIT side by kind: for kind 'sell' lower buyAmount (your minimum out); for kind 'buy' raise sellAmount (your maximum in). Sign `order` as EIP-712 with `signing`, then call submit_order.",
        inputSchema: {
          chainId: z.number().int(),
          owner: z.string().describe('The signer/owner address (receiver defaults to this).'),
          sellToken: z.string(),
          buyToken: z.string(),
          sellAmount: z
            .string()
            .describe("In atoms. kind 'sell': the EXACT amount you sell. kind 'buy': the MAXIMUM you'll spend (slippage-adjusted UP from the quote)."),
          buyAmount: z
            .string()
            .describe("In atoms. kind 'sell': the MINIMUM you accept (slippage-adjusted DOWN from the quote). kind 'buy': the EXACT amount you want to receive."),
          kind: z.enum(['sell', 'buy']),
          validForSeconds: z.number().int().positive().optional().describe('Order lifetime (default 1200 = 20 min).'),
          feeAmount: z.string().optional().describe('Signed feeAmount in atoms (default "0" — CoW fee is in surplus).'),
          partiallyFillable: z.boolean().optional(),
          slippageBips: z.number().int().nonnegative().optional().describe('Recorded in appData metadata.'),
          unsafeCustomReceiver: z
            .string()
            .optional()
            .describe('DANGER: send proceeds to a non-owner address. The autonomous-agent drain vector — only set if intentional.'),
        },
      },
      async (a) => {
        try {
          return ok(
            buildOrder(
              {
                chainId: a.chainId,
                owner: a.owner as Address,
                sellToken: a.sellToken as Address,
                buyToken: a.buyToken as Address,
                sellAmount: a.sellAmount,
                buyAmount: a.buyAmount,
                kind: a.kind,
                validForSeconds: a.validForSeconds,
                feeAmount: a.feeAmount,
                partiallyFillable: a.partiallyFillable,
                slippageBips: a.slippageBips,
                unsafeCustomReceiver: a.unsafeCustomReceiver as Address | undefined,
              },
              Math.floor(Date.now() / 1000),
            ),
          )
        } catch (e) {
          return fail(e)
        }
      },
    )

    this.server.registerTool(
      'submit_order',
      {
        description:
          'Relay a PRE-SIGNED order to the chain\'s Ophis orderbook. Pass the exact `order` object and `fullAppData` from build_order, plus your EIP-712 `signature` and `from` (owner). The MCP holds no keys — it only forwards. Returns the order UID on success.',
        inputSchema: {
          chainId: z.number().int(),
          order: z
            .object({
              sellToken: z.string(),
              buyToken: z.string(),
              receiver: z.string(),
              sellAmount: z.string(),
              buyAmount: z.string(),
              validTo: z.number().int(),
              appData: z.string(),
              feeAmount: z.string(),
              kind: z.enum(['sell', 'buy']),
              partiallyFillable: z.boolean(),
              sellTokenBalance: z.literal('erc20'),
              buyTokenBalance: z.literal('erc20'),
            })
            .describe('The order object returned by build_order.'),
          signature: z.string().describe('0x EIP-712 signature over the order by the owner.'),
          signingScheme: z.enum(['eip712', 'ethsign']).optional(),
          from: z.string().describe('The owner address that signed.'),
          fullAppData: z.string().describe('The fullAppData string returned by build_order.'),
          allowCustomReceiver: z
            .boolean()
            .optional()
            .describe('Required (true) to relay an order whose receiver is not the owner. Default refuses — drain guard.'),
        },
      },
      async (a) => {
        try {
          return ok(
            await submitOrder({
              chainId: a.chainId,
              order: a.order as never,
              signature: a.signature,
              signingScheme: a.signingScheme,
              from: a.from as Address,
              fullAppData: a.fullAppData,
              allowCustomReceiver: a.allowCustomReceiver,
            }),
          )
        } catch (e) {
          return fail(e)
        }
      },
    )

    this.server.registerTool(
      'lookup_tier',
      {
        description:
          "Look up a wallet's Ophis fee-rebate tier and live status (30-day volume → bronze/silver/gold/platinum, rebate %). Returns the indexer status plus the static tier ladder.",
        inputSchema: { wallet: z.string().describe('Wallet address (0x...).') },
      },
      async ({ wallet }) => {
        try {
          return ok(await lookupTier(wallet as Address))
        } catch (e) {
          return fail(e)
        }
      },
    )

    this.server.registerTool(
      'list_chains',
      {
        description:
          "List Ophis chains, split into `tradeable` (orderbook host is live — only route get_quote/build_order to these) and `paused` (settlement deployed but no live orderbook yet, e.g. MegaETH/HyperEVM — these throw). Each tradeable chain includes its orderbook host and GPv2Settlement contract (Optimism/MegaETH/HyperEVM are non-canonical) and partner-fee config. No input.",
        inputSchema: {},
      },
      async () => {
        try {
          return ok(listChains())
        } catch (e) {
          return fail(e)
        }
      },
    )
  }
}

const INFO = {
  name: 'Ophis MCP',
  description: 'Agent-facing tools for the Ophis DEX: parse swap intents, fetch quotes, build bounded signable CoW orders, submit signed orders, look up fee-rebate tiers.',
  transport: { type: 'streamable-http', endpoint: '/mcp' },
  tools: ['parse_intent', 'get_quote', 'build_order', 'submit_order', 'lookup_tier', 'list_chains'],
  docs: 'https://docs.ophis.fi/',
  source: 'https://github.com/ophis-fi/ophis',
  security: 'Holds no private keys. build_order pins the order receiver to the owner; the agent signs locally.',
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
