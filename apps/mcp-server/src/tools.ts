/**
 * Ophis MCP tool registration — shared between the Cloudflare Worker
 * (src/index.ts, Streamable HTTP) and the standalone stdio server
 * (src/standalone.ts, plain Node). Both register the SAME six tools against an
 * McpServer; only the transport and how config is sourced differ.
 *
 * The server holds NO private keys and never signs. build_order returns a
 * payload the calling agent signs with its own key. Public + unauthenticated:
 * every backing endpoint is already public, and the tools are read/build-only.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  parseIntent,
  getQuote,
  buildOrder,
  submitOrder,
  lookupTier,
  listChains,
  extractQuoteAmounts,
  assertLimitWithinSlippage,
  type Address,
} from './ophis.js'

/** Identity reported by both transports (stdio + Worker). */
export const SERVER_INFO = { name: 'ophis', version: '0.0.1' } as const

/**
 * Runtime-supplied config for the tools. On the Worker these come from the DO
 * Env bindings; on the stdio server they come from process.env. Both are
 * optional — the tools work without them (no default referral code, production
 * rebate indexer).
 */
export interface OphisToolConfig {
  /** Optional server-wide default affiliate referral code. When set, build_order
   *  embeds it in appData unless the call passes its own referrerCode. Lets an
   *  operator attribute every order from their MCP instance to their own code. */
  defaultReferrerCode?: string
  /** Rebate-indexer base URL. submit_order pings {base}/tier/<owner> to register
   *  a referrer-tagged order's owner for indexing (so the affiliate is actually
   *  credited). Defaults to the production indexer. */
  rebatesApi?: string
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}
function fail(e: unknown) {
  const msg = (e as Error)?.message ?? String(e)
  const capped = msg.length > 500 ? msg.slice(0, 500) + '…' : msg
  return { content: [{ type: 'text' as const, text: `Error: ${capped}` }], isError: true }
}

/**
 * Registers the six Ophis MCP tools on `server`. Behaviour-identical to the
 * original OphisMCP.init(); the only difference is config is passed in rather
 * than read from a Worker Env (so the same tools run under stdio too).
 */
export function registerOphisTools(server: McpServer, config?: OphisToolConfig): void {
  server.registerTool(
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

  server.registerTool(
    'get_quote',
    {
      description:
        "Fetch a best-execution quote from the chain's Ophis orderbook (use a chainId from list_chains' `tradeable`). Amounts are in atoms (smallest unit, uint256 decimal string). For kind='sell' the amount is the sell amount before fee; for kind='buy' it is the desired buy amount. Returns the orderbook quote (sellAmount/buyAmount/feeAmount/validTo). Before build_order, apply slippage to the limit side by kind: kind='sell' -> lower buyAmount (min out); kind='buy' -> raise sellAmount (max in).",
      inputSchema: {
        chainId: z.number().int().describe('EVM chain id (use list_chains for supported chains).'),
        sellToken: z.string().describe('Sell token address (0x...).'),
        buyToken: z.string().describe('Buy token address (0x...).'),
        kind: z
          .enum(['sell', 'buy'])
          .describe("'sell' = you specify the sell amount; 'buy' = you specify the buy amount."),
        amount: z.string().describe('Amount in atoms (uint256 decimal string).'),
        from: z.string().describe('The trading account address (quotes are account-aware).'),
        validForSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Quote validity window in seconds (default 1200 = 20 min).'),
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

  server.registerTool(
    'build_order',
    {
      description:
        "Build a bounded, ready-to-sign CoW order on Ophis. Returns { order, signing:{domain,types,primaryType}, fullAppData, appDataHash, partnerFee, next }. The receiver is ALWAYS PINNED to the owner (proceeds cannot leave the account); this public endpoint exposes no custom-receiver option. Uses the correct per-chain settlement contract (Optimism/MegaETH/HyperEVM are non-canonical) and embeds the CIP-75 partner fee. Apply slippage to the LIMIT side by kind: for kind 'sell' lower buyAmount (your minimum out); for kind 'buy' raise sellAmount (your maximum in). slippageBips is capped at 5000 (50%, default = the cap) and ENFORCED: build_order fetches a live quote and REJECTS the call if the limit is worse than slippageBips vs that quote (or if a quote cannot be fetched — retry). Sign `order` as EIP-712 with `signing`, then call submit_order.",
      inputSchema: {
        chainId: z.number().int().describe('EVM chain id (use a chainId from list_chains `tradeable`).'),
        owner: z.string().describe('The signer/owner address (receiver defaults to this).'),
        sellToken: z.string().describe('Sell token address (0x...).'),
        buyToken: z.string().describe('Buy token address (0x...).'),
        sellAmount: z
          .string()
          .describe("In atoms. kind 'sell': the EXACT amount you sell. kind 'buy': the MAXIMUM you'll spend (slippage-adjusted UP from the quote)."),
        buyAmount: z
          .string()
          .describe("In atoms. kind 'sell': the MINIMUM you accept (slippage-adjusted DOWN from the quote). kind 'buy': the EXACT amount you want to receive."),
        kind: z
          .enum(['sell', 'buy'])
          .describe(
            "'sell' = sellAmount is exact and buyAmount is your minimum out; 'buy' = buyAmount is exact and sellAmount is your maximum in.",
          ),
        validForSeconds: z
          .number()
          .int()
          .min(60)
          .optional()
          .describe(
            'Order lifetime in seconds (default 1200 = 20 min; minimum 60). The enforced live-quote fetch can consume several seconds, so very short lifetimes would return a near-expired order the orderbook rejects.',
          ),
        // feeAmount must be 0 on this public tool: Ophis orders take the fee from
        // surplus + the CIP-75 appData partner fee, never a signed feeAmount. CoW
        // accounting treats a signed feeAmount as ADDITIONAL sell-token spend that
        // the slippage check does not cover, so a non-zero fee is a fleecing vector
        // on a no-auth tool. Reject it explicitly rather than silently strip it. (reviewer P1)
        feeAmount: z
          .string()
          .optional()
          .refine((v) => v === undefined || v === '0', {
            message:
              'feeAmount must be omitted or "0" — Ophis orders take the fee from surplus + the appData partner fee; a non-zero signed feeAmount is not accepted on this tool.',
          })
          .describe('Signed feeAmount in atoms. Must be omitted or "0" on this tool (the fee is taken from surplus + the appData partner fee).'),
        partiallyFillable: z.boolean().optional().describe('Allow partial fills (default false = fill-or-kill).'),
        slippageBips: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Max accepted slippage in bips; capped at 5000 (50%, the default bound); recorded in appData. ENFORCED: build_order fetches a live quote and rejects a limit worse than this vs the quote. Fund safety: the receiver is always pinned to the owner.',
          ),
        // Retired fields (#611 -> #612 -> #613): slippage was briefly bounded against
        // a CALLER-supplied reference, which is fakeable on a no-auth tool. It is now
        // enforced server-side against a live quote, so these are gone. Reject them
        // explicitly — the raw shape would otherwise strip them, leaving an old client
        // falsely believing its guard ran. (reviewer P2)
        referenceBuyAmount: z
          .any()
          .optional()
          .refine((v) => v === undefined, {
            message:
              'referenceBuyAmount was removed — slippage is now enforced server-side against a live quote. Remove it (optionally set slippageBips).',
          }),
        referenceSellAmount: z
          .any()
          .optional()
          .refine((v) => v === undefined, {
            message:
              'referenceSellAmount was removed — slippage is now enforced server-side against a live quote. Remove it (optionally set slippageBips).',
          }),
        // SECURITY (#608 review): no custom-receiver field is exposed on this
        // public, no-auth tool. The receiver is unconditionally pinned to the
        // owner so a prompt-injected agent cannot build an order that drains to
        // a third party. The @ophis/sdk buildOrder still supports a custom
        // receiver for authenticated/programmatic use; it is intentionally not
        // surfaced here.
        referrerCode: z
          .string()
          .optional()
          .describe('Affiliate referral code to embed in appData (credits that code\'s owner for this trade). Defaults to the server\'s OPHIS_DEFAULT_REFERRER_CODE if set. Grammar: 3-64 chars [a-z0-9_-]; an invalid code errors.'),
      },
    },
    async (a) => {
      try {
        const built = buildOrder(
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
            // unsafeCustomReceiver intentionally NOT forwarded — see the schema
            // note above; buildOrder therefore pins the receiver to the owner.
            // Per-call code wins; otherwise the server's configured default
            // (so an operator can attribute all orders to their own code).
            referrerCode: a.referrerCode ?? config?.defaultReferrerCode,
          },
          Math.floor(Date.now() / 1000),
        )
        // Enforce slippage against a TRUSTED, server-fetched quote (NOT a caller
        // value — a caller-supplied reference is fakeable on this no-auth tool;
        // reviewer P1). FAIL CLOSED: if we cannot fetch AND parse a live quote we
        // cannot bound the limit, so reject (the agent retries) rather than emit
        // an unverified "bounded" order. This also rejects un-quoteable routes
        // (no liquidity / 4xx) instead of silently bypassing the check.
        let quote: unknown
        try {
          quote = await getQuote({
            chainId: a.chainId,
            sellToken: a.sellToken as Address,
            buyToken: a.buyToken as Address,
            kind: a.kind,
            amount: a.kind === 'sell' ? a.sellAmount : a.buyAmount,
            from: a.owner as Address,
          })
        } catch (qe) {
          throw new Error(
            `build_order: could not fetch a live quote to verify slippage (${(qe as Error)?.message ?? qe}); retry shortly`,
          )
        }
        const fair = extractQuoteAmounts(quote)
        if (!fair) {
          throw new Error('build_order: the quote response was unusable, so slippage could not be verified; retry shortly')
        }
        // Throws (-> rejected) if the limit is worse than slippageBips (default 50%
        // cap). The CIP-75 partner fee embedded in THIS order widens the bound: a
        // fee-chain order signs amounts net of that fee, so without the allowance a
        // correctly-built order would be false-rejected. (reviewer P1)
        assertLimitWithinSlippage(a.kind, a.sellAmount, a.buyAmount, fair, a.slippageBips, built.partnerFee?.volumeBps ?? 0)
        return ok(built)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'submit_order',
    {
      description:
        'Relay a PRE-SIGNED order to the chain\'s Ophis orderbook. Pass the exact `order` object and `fullAppData` from build_order, plus your EIP-712 `signature` and `from` (owner). The MCP holds no keys — it only forwards. Returns the order UID on success.',
      inputSchema: {
        chainId: z.number().int().describe('EVM chain id the order was built for.'),
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
        signingScheme: z
          .enum(['eip712', 'ethsign'])
          .optional()
          .describe("Signature scheme over the order (default 'eip712')."),
        from: z.string().describe('The owner address that signed.'),
        fullAppData: z.string().describe('The fullAppData string returned by build_order.'),
        // SECURITY (#608 review): no allowCustomReceiver field — submit_order
        // unconditionally refuses to relay an order whose receiver is not the
        // owner (drain guard), so even an externally-built custom-receiver order
        // signed by the owner cannot be relayed through this public endpoint.
      },
    },
    async (a) => {
      try {
        const result = await submitOrder({
          chainId: a.chainId,
          order: a.order as never,
          signature: a.signature,
          signingScheme: a.signingScheme,
          from: a.from as Address,
          fullAppData: a.fullAppData,
          // allowCustomReceiver intentionally NOT forwarded — submitOrder defaults
          // to refusing any non-owner receiver (drain guard). See the schema note.
        })
        // The order was accepted by the orderbook (a real, signed order). If it
        // carries an affiliate referral code, register the owner so the rebate
        // indexer (which fetches trades per tracked wallet) actually indexes
        // this trade and credits the referrer — otherwise a pure agent-routed
        // wallet that never visits the swap UI would never be fetched. Best
        // effort + fire-and-forget: a registration failure must NOT fail the
        // already-relayed order. Gated on a referral tag so untagged orders do
        // not grow tracked_wallets, and only after a successful relay so a bogus
        // submit cannot register arbitrary wallets.
        try {
          const ref = (JSON.parse(a.fullAppData) as { metadata?: { ophisReferrer?: { code?: unknown } } })
            ?.metadata?.ophisReferrer?.code
          if (typeof ref === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.from)) {
            const base = config?.rebatesApi ?? 'https://rebates.ophis.fi'
            // AWAIT (not fire-and-forget): a bare background fetch in a Durable
            // Object can be cancelled once the response returns, making the
            // registration unreliable. Await it so it actually completes, bounded
            // by a short timeout and fully swallowed so it can never delay-fail or
            // fail the already-relayed order.
            await fetch(`${base}/tier/${a.from.toLowerCase()}`, {
              signal: AbortSignal.timeout(2500),
            }).catch(() => {})
          }
        } catch {
          // Malformed fullAppData: skip registration, the order still succeeded.
        }
        return ok(result)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
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

  server.registerTool(
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
