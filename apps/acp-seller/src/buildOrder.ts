/**
 * Ophis order-build bridge for the ACP seller handler.
 *
 * Given a parsed swap request, this fetches a live quote from the chain's Ophis
 * orderbook, applies slippage to the limit side, embeds the Ophis partner fee via
 * the @ophis/sdk helper, pins the receiver to the buyer, and returns a bounded,
 * ready-to-sign order. It holds no keys: the buyer signs the returned order with
 * its own key.
 */
import { keccak256, toUtf8Bytes } from 'ethers'
import {
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  buildOphisAppDataPartnerFee,
  assertReceiverIsOwner,
} from '@ophis/sdk'

export interface SwapRequest {
  chainId: number
  sellToken: `0x${string}`
  buyToken: `0x${string}`
  /** Sell amount in atoms (smallest unit, uint256 decimal string). */
  sellAmount: string
  /** The buyer's own receiving address. The order receiver is pinned to it. */
  owner: `0x${string}`
  /** Max accepted slippage in bips (default 100 = 1%). */
  slippageBips?: number
}

/** The deliverable: everything the buyer needs to sign and submit, no keys held here. */
export interface SignableOrder {
  chainId: number
  orderbookUrl: string
  order: Record<string, unknown>
  signing: { domain: unknown; types: unknown; primaryType: 'Order' }
  fullAppData: string
  appDataHash: string
  note: string
}

const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const

/** Apply a downward slippage bound to the quoted buy amount (exact-in sell). */
function minBuyAmount(quotedBuy: string, slippageBips: number): string {
  const q = BigInt(quotedBuy)
  const out = (q * BigInt(10_000 - slippageBips)) / BigInt(10_000)
  return out.toString()
}

/** Upper bound on accepted slippage (50%); anything higher is almost certainly a mistake. */
export const MAX_SLIPPAGE_BIPS = 5000

/**
 * Decide whether a parsed request is actually fulfillable, BEFORE the buyer is
 * asked to pay. A requirement can parse yet be unfulfillable: an unsupported
 * chain (no live Ophis orderbook) or a non-finite / out-of-range slippage that
 * would make BigInt(10_000 - slippageBips) throw or produce a nonsense bound.
 * REQUEST and TRANSACTION both call this so they agree on what is accepted.
 * Returns null when fulfillable, otherwise a human-readable reason.
 */
export function validateFulfillable(req: SwapRequest): string | null {
  // getOphisOrderbookUrl THROWS for an unsupported/invalid chain id (it asserts a
  // valid chain and has no entry), it does not return a falsy value. Catch it so
  // an unfulfillable requirement returns a clean reason and is rejected BEFORE
  // payment, instead of throwing and skipping the graceful reject path.
  let hasOrderbook = false
  try {
    hasOrderbook = Boolean(getOphisOrderbookUrl(req.chainId))
  } catch {
    hasOrderbook = false
  }
  if (!hasOrderbook) {
    return `chain ${req.chainId} has no live Ophis orderbook`
  }
  if (req.slippageBips !== undefined) {
    const s = req.slippageBips
    if (!Number.isInteger(s) || s < 0 || s > MAX_SLIPPAGE_BIPS) {
      return `slippageBips must be an integer between 0 and ${MAX_SLIPPAGE_BIPS}`
    }
  }
  return null
}

export async function buildSignableOrder(req: SwapRequest, nowSeconds: number): Promise<SignableOrder> {
  // Guard here too so a direct caller cannot reach the quote/BigInt path with an
  // unfulfillable request; REQUEST-phase acceptance uses the same check.
  const problem = validateFulfillable(req)
  if (problem) throw new Error(problem)
  const slippageBips = req.slippageBips ?? 100
  const orderbookUrl = getOphisOrderbookUrl(req.chainId)
  if (!orderbookUrl) throw new Error(`chain ${req.chainId} has no live Ophis orderbook`)

  // 1. appData: appCode 'ophis' + the Ophis partner fee from the SDK helper (the
  //    flat 5 bps partner rate). The reduced 1 bp stable rate is deliberately NOT
  //    applied from a caller-supplied flag: that would let a buyer claim a stable
  //    pair to underpay. Defaulting to the standard rate is always safe, and
  //    matches the keyless MCP. The buyer can add its own fee entry separately.
  const partnerFee = buildOphisAppDataPartnerFee(req.chainId)
  const metadata: Record<string, unknown> = { orderClass: { orderClass: 'market' }, ophisSource: { app: 'acp' } }
  if (partnerFee) metadata.partnerFee = partnerFee
  const appDataDoc = { version: '1.4.0', appCode: 'ophis', metadata }
  // Hash the exact string that will be submitted (the orderbook checks
  // keccak256(submittedFullAppData) === order.appData; byte parity with cow-sdk
  // is not required as long as the same string is submitted).
  const fullAppData = JSON.stringify(appDataDoc)
  const appDataHash = keccak256(toUtf8Bytes(fullAppData))

  // 2. Quote from the chain's Ophis orderbook (account-aware, fee-aware).
  const quoteBody = {
    sellToken: req.sellToken,
    buyToken: req.buyToken,
    from: req.owner,
    receiver: req.owner,
    kind: 'sell',
    sellAmountBeforeFee: req.sellAmount,
    appData: fullAppData,
    appDataHash,
    signingScheme: 'eip712',
    priceQuality: 'optimal',
  }
  const res = await fetch(`${orderbookUrl}/api/v1/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(quoteBody),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`quote failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const quote = (await res.json()) as { quote?: { sellAmount: string; buyAmount: string; feeAmount: string; validTo: number } }
  const q = quote.quote
  if (!q) throw new Error('quote response missing `quote`')

  // 3. Bound the limit: minimum buy after slippage; receiver pinned to the buyer.
  const receiver = req.owner
  assertReceiverIsOwner(req.owner, receiver)
  const validTo = Math.max(q.validTo, nowSeconds + 600)
  const order = {
    sellToken: req.sellToken,
    buyToken: req.buyToken,
    receiver,
    sellAmount: q.sellAmount,
    buyAmount: minBuyAmount(q.buyAmount, slippageBips),
    validTo,
    appData: appDataHash,
    // feeAmount is 0 by design: current CoW/Ophis orders take the fee from the
    // trade output via the appData partner fee, not a signed feeAmount (the MCP
    // build_order enforces the same). A non-zero signed feeAmount would be extra
    // sell-token spend the slippage bound does not cover.
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  }

  return {
    chainId: req.chainId,
    orderbookUrl,
    order,
    signing: { domain: getOphisOrderDomain(req.chainId), types: ORDER_TYPES, primaryType: 'Order' },
    fullAppData,
    appDataHash,
    // Template literal so orderbookUrl is interpolated to the real URL (the old
    // single-quoted form emitted the ${...} token verbatim). Inner backticks
    // around `order`/`signing` are escaped literals.
    note:
      `Sign \`order\` as EIP-712 with \`signing\`, then POST ` +
      `{ ...order, from, signingScheme: "eip712", signature, appData: fullAppData, appDataHash } ` +
      `to ${orderbookUrl}/api/v1/orders, or relay it through the Ophis MCP submit_order tool. ` +
      `Ophis holds no keys.`,
  }
}

/**
 * Parse an ACP job requirement into a SwapRequest. Accepts either a structured
 * object (preferred) or a JSON string carrying the same fields. Natural-language
 * requirements should be pre-resolved by the buyer via the Ophis Intent API.
 */
export function parseSwapRequirement(requirement: unknown): SwapRequest | null {
  let r: Record<string, unknown> | null = null
  if (typeof requirement === 'string') {
    try {
      r = JSON.parse(requirement) as Record<string, unknown>
    } catch {
      return null
    }
  } else if (requirement && typeof requirement === 'object') {
    r = requirement as Record<string, unknown>
  }
  if (!r) return null
  const chainId = Number(r.chainId)
  const { sellToken, buyToken, sellAmount, owner } = r as Record<string, string>
  const addr = /^0x[0-9a-fA-F]{40}$/
  if (
    !Number.isInteger(chainId) ||
    !addr.test(sellToken ?? '') ||
    !addr.test(buyToken ?? '') ||
    !addr.test(owner ?? '') ||
    !/^\d+$/.test(sellAmount ?? '')
  ) {
    return null
  }
  return {
    chainId,
    sellToken: sellToken as `0x${string}`,
    buyToken: buyToken as `0x${string}`,
    sellAmount,
    owner: owner as `0x${string}`,
    // No fee-selecting flag is read from the (untrusted) requirement: the fee
    // rate is set server-side by the SDK helper, never by the caller, so a buyer
    // cannot claim a cheaper rate to underpay.
    slippageBips: r.slippageBips !== undefined ? Number(r.slippageBips) : undefined,
  }
}
