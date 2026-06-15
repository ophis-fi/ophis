/**
 * Ophis MCP core logic — pure helpers + thin API callers.
 *
 * Split out from index.ts so the order-building / appData-hashing logic is
 * unit-testable in plain Node (vitest), independent of the Worker/MCP runtime.
 *
 * Design: the MCP holds NO keys and NEVER signs. `build_order` returns a
 * bounded, ready-to-sign EIP-712 payload (receiver pinned to the owner — the
 * #1 autonomous-agent drain vector); the agent signs with its own key and
 * submits. This is the V1 "bounded capability" pattern from the Ophis
 * agent-trading design, not an on-chain authorization boundary.
 */
import { keccak256, toBytes, isAddress, getAddress } from 'viem'

import {
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  buildOphisAppDataPartnerFee,
  buildOphisReferrerMetadata,
  ophisOrderReceiver,
  assertReceiverIsOwner,
  ophisDefaultPartnerFee,
  OPHIS_CHAIN_IDS,
  OPHIS_FEE_CHAIN_IDS,
  OPHIS_ORDERBOOK_URLS,
  OPHIS_SETTLEMENT_ADDRESSES,
  assignTier,
  TIERS,
  type OphisOrderDomain,
  type OphisPartnerFee,
  type Tier,
} from '@ophis/sdk'

/** CoW appData schema version the live Ophis frontend emits (cow-sdk LATEST_APP_DATA_VERSION). */
export const APP_DATA_VERSION = '1.14.0'

/** The address that receives bought tokens is part of the signed payload (drain vector). */
export type Address = `0x${string}`

/** EIP-712 struct for a CoW GPv2 order. Mirrors @cowprotocol/contracts ORDER_TYPE_FIELDS. */
export const ORDER_TYPED_DATA_TYPES = {
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

/**
 * Deterministic JSON: object keys sorted ascending, recursively; `undefined`
 * values dropped. Mirrors cow-sdk's `stringifyDeterministic` closely enough
 * that the orderbook accepts the doc — the orderbook only requires
 * `keccak256(submittedFullAppData) === order.appData`, and we submit the exact
 * string we hashed, so byte-for-byte parity with cow-sdk is not required.
 */
export function deterministicStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}

export interface OphisAppData {
  /** The full appData JSON document (parsed). */
  doc: Record<string, unknown>
  /** The exact serialized string to submit as `appData` to the orderbook. */
  fullAppData: string
  /** keccak256 of `fullAppData` — the bytes32 that goes into the signed order. */
  appDataHash: Address
  /** The CIP-75 partner fee applied on this chain, or undefined where Ophis charges none. */
  partnerFee?: OphisPartnerFee
}

/**
 * Builds the Ophis appData document for a chain: appCode "Ophis", market
 * orderClass, and the CIP-75 partner fee (flat `volumeBps` shape, 10 bps,
 * from @ophis/sdk buildOphisAppDataPartnerFee) where Ophis charges one.
 * Returns the doc, its deterministic serialization, and its keccak256 hash.
 */
export function buildOphisAppData(chainId: number, slippageBips?: number, referrerCode?: string): OphisAppData {
  const partnerFee = buildOphisAppDataPartnerFee(chainId)
  const metadata: Record<string, unknown> = { orderClass: { orderClass: 'market' } }
  if (partnerFee) metadata.partnerFee = partnerFee
  if (slippageBips !== undefined) metadata.quote = { slippageBips }
  // Affiliate attribution: tag the order with a referral code under
  // metadata.ophisReferrer.code so the rebate indexer credits that code's owner
  // for this trade's volume. buildOphisReferrerMetadata validates the grammar
  // (throws on a malformed code) so a bad code fails the build, not silently.
  if (referrerCode !== undefined) Object.assign(metadata, buildOphisReferrerMetadata(referrerCode))

  const doc: Record<string, unknown> = { version: APP_DATA_VERSION, appCode: 'Ophis', metadata }
  const fullAppData = deterministicStringify(doc)
  const appDataHash = keccak256(toBytes(fullAppData))
  return { doc, fullAppData, appDataHash, partnerFee }
}

export interface BuildOrderParams {
  chainId: number
  owner: Address
  sellToken: Address
  buyToken: Address
  /**
   * sellAmount in atoms (uint256 decimal string). For kind 'sell' this is the
   * EXACT amount you sell. For kind 'buy' it is the MAXIMUM you are willing to
   * spend (slippage-adjusted UP from the quote's sellAmount).
   */
  sellAmount: string
  /**
   * buyAmount in atoms (uint256 decimal string). For kind 'sell' this is the
   * MINIMUM you will accept (slippage-adjusted DOWN from the quote's buyAmount).
   * For kind 'buy' it is the EXACT amount you want to receive.
   */
  buyAmount: string
  kind: 'sell' | 'buy'
  /** Order lifetime in seconds from now (default 1200 = 20 min). */
  validForSeconds?: number
  /** feeAmount in the signed order. CoW market orders sign 0 (fee is in surplus). */
  feeAmount?: string
  partiallyFillable?: boolean
  /** Max accepted slippage in bips, capped at 5000 (50%); recorded in appData
   * metadata. NOTE: NOT enforced against a price oracle. build_order has no
   * trusted quote (a caller-supplied reference would be fakeable on this public
   * no-auth tool), so the limit amounts are the caller/signer's responsibility.
   * Fund safety comes from the unconditionally-pinned receiver (proceeds can only
   * reach the owner) plus CoW returning surplus to the trader. */
  slippageBips?: number
  /**
   * Opt in to a non-owner receiver. The proceeds leave the account — this is
   * the autonomous-agent drain vector, so it is loudly named and off by default.
   */
  unsafeCustomReceiver?: Address
  /**
   * Affiliate referral code to embed in appData (metadata.ophisReferrer.code).
   * Credits that code's owner for this trade's volume. Validated against the
   * registry grammar; an invalid code throws.
   */
  referrerCode?: string
}

export interface BuiltOrder {
  chainId: number
  owner: Address
  orderbookUrl: string
  /** The CoW order to sign (EIP-712 message). `appData` is the keccak256 hash. */
  order: {
    sellToken: Address
    buyToken: Address
    receiver: Address
    sellAmount: string
    buyAmount: string
    validTo: number
    appData: Address
    feeAmount: string
    kind: 'sell' | 'buy'
    partiallyFillable: boolean
    sellTokenBalance: 'erc20'
    buyTokenBalance: 'erc20'
  }
  /** EIP-712 typed-data envelope: sign `order` against this. */
  signing: { domain: OphisOrderDomain; types: typeof ORDER_TYPED_DATA_TYPES; primaryType: 'Order' }
  /** The full appData string to pass to submit_order (the orderbook re-hashes it). */
  fullAppData: string
  appDataHash: Address
  partnerFee?: OphisPartnerFee
  /** Step-by-step next action for the calling agent. */
  next: string
}

/**
 * Builds a bounded, ready-to-sign CoW order on Ophis. Pins the receiver to the
 * owner (unless unsafeCustomReceiver is set), uses the correct per-chain
 * settlement contract (Optimism/MegaETH/HyperEVM are NON-canonical) and
 * orderbook host, and embeds the CIP-75 partner fee in appData. Pure — no
 * network, no keys.
 */
export function buildOrder(p: BuildOrderParams, nowSeconds: number): BuiltOrder {
  const chainId = assertChain(p.chainId)
  const owner = checksum(p.owner, 'owner')
  const sellToken = checksum(p.sellToken, 'sellToken')
  const buyToken = checksum(p.buyToken, 'buyToken')
  assertAtoms(p.sellAmount, 'sellAmount')
  assertAtoms(p.buyAmount, 'buyAmount')
  if (p.feeAmount !== undefined) assertFeeAtoms(p.feeAmount, 'feeAmount')
  assertSlippageCap(p)

  const receiver = ophisOrderReceiver(
    owner,
    p.unsafeCustomReceiver ? { unsafeCustomReceiver: checksum(p.unsafeCustomReceiver, 'unsafeCustomReceiver') } : {},
  )
  // Hard guard immediately before the order is handed back for signing.
  assertReceiverIsOwner(owner, receiver, { allowCustomReceiver: p.unsafeCustomReceiver !== undefined })

  const { fullAppData, appDataHash, partnerFee } = buildOphisAppData(chainId, p.slippageBips, p.referrerCode)
  const validFor = p.validForSeconds ?? 1200
  if (!Number.isInteger(validFor) || validFor <= 0 || validFor > 60 * 60 * 24 * 365) {
    throw new Error(`build_order: validForSeconds must be a positive integer < 1 year, got ${validFor}`)
  }
  const validTo = Math.floor(nowSeconds) + validFor

  return {
    chainId,
    owner,
    orderbookUrl: getOphisOrderbookUrl(chainId),
    order: {
      sellToken,
      buyToken,
      receiver,
      sellAmount: p.sellAmount,
      buyAmount: p.buyAmount,
      validTo,
      appData: appDataHash,
      feeAmount: p.feeAmount ?? '0',
      kind: p.kind,
      partiallyFillable: p.partiallyFillable ?? false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
    signing: { domain: getOphisOrderDomain(chainId), types: ORDER_TYPED_DATA_TYPES, primaryType: 'Order' },
    fullAppData,
    appDataHash,
    partnerFee,
    next:
      "Sign `order` as EIP-712 typed data using `signing` (domain/types/primaryType='Order') with the owner key. " +
      'Then call submit_order with { chainId, order, signature, signingScheme: "eip712", from: owner, fullAppData }.',
  }
}

// --- API callers (real endpoints, no mocks) --------------------------------

// Intent parser host. Deliberately swap.ophis.fi, NOT ophis.fi: verified
// 2026-05-29 that https://ophis.fi/api/intent returns HTTP 500
// {"code":"UPSTREAM","message":"LibertAI key not configured"} (the Pages
// Function is deployed on the landing project without the key bound), while
// https://swap.ophis.fi/api/intent returns a real 200 parse. swap.ophis.fi is
// the live, key-bound endpoint that the swap app itself calls.
const INTENT_API = 'https://swap.ophis.fi/api/intent'
const REBATE_API = 'https://rebates.ophis.fi'

/** Per-upstream timeouts. A hung upstream must not pin the Worker subrequest / billable DO duration. */
const TIMEOUT_MS = { intent: 15_000, orderbook: 12_000, rebate: 8_000 } as const

/** fetch with a hard timeout; re-labels AbortError/TimeoutError into a clear, bounded message. */
async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
  label: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) })
  } catch (e) {
    const name = (e as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`${label}: upstream timed out after ${ms}ms`)
    throw e
  }
}

export interface IntentEntity {
  type: 'sellToken' | 'buyToken' | 'amount' | 'chain'
  value: string
  raw: string
  start: number
  end: number
}
export interface ParsedIntent {
  intent: 'swap' | 'unknown'
  entities: IntentEntity[]
}

/** Calls the live Ophis intent parser (LibertAI Qwen). Throws with the API's error code on failure. */
export async function parseIntent(text: string, fetchImpl: typeof fetch = fetch): Promise<ParsedIntent> {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('parse_intent: text is required')
  if (text.length > 280) throw new Error('parse_intent: text exceeds 280 chars')
  const res = await timedFetch(
    fetchImpl,
    INTENT_API,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
    TIMEOUT_MS.intent,
    'parse_intent',
  )
  const json = (await res.json()) as { ok: boolean; data?: ParsedIntent; error?: { code: string; message: string } }
  if (!json.ok || !json.data) {
    throw new Error(`parse_intent failed: ${json.error?.code ?? res.status} ${json.error?.message ?? ''}`.trim())
  }
  return json.data
}

export interface QuoteParams {
  chainId: number
  sellToken: Address
  buyToken: Address
  /** 'sell' = you specify sellAmount; 'buy' = you specify buyAmount. */
  kind: 'sell' | 'buy'
  /** Amount in atoms (uint256 decimal string): sellAmountBeforeFee for sell, buyAmountAfterFee for buy. */
  amount: string
  /** The trading account. Quotes are account-aware (balances/permits). */
  from: Address
  validForSeconds?: number
}

/** Fetches a quote from the chain's Ophis orderbook (`POST /api/v1/quote`). Returns the raw orderbook response. */
export async function getQuote(p: QuoteParams, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const chainId = assertChain(p.chainId)
  const from = checksum(p.from, 'from')
  const sellToken = checksum(p.sellToken, 'sellToken')
  const buyToken = checksum(p.buyToken, 'buyToken')
  assertAtoms(p.amount, 'amount')
  const { fullAppData, appDataHash } = buildOphisAppData(chainId)
  const amountKey = p.kind === 'sell' ? 'sellAmountBeforeFee' : 'buyAmountAfterFee'
  const body: Record<string, unknown> = {
    sellToken,
    buyToken,
    from,
    receiver: from,
    kind: p.kind,
    [amountKey]: p.amount,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    priceQuality: 'optimal',
    signingScheme: 'eip712',
    onchainOrder: false,
    appData: fullAppData,
    appDataHash,
    validFor: p.validForSeconds ?? 1200,
  }
  const url = `${getOphisOrderbookUrl(chainId)}/api/v1/quote`
  const res = await timedFetch(
    fetchImpl,
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    TIMEOUT_MS.orderbook,
    'get_quote',
  )
  const json = await res.json()
  if (!res.ok) {
    throw new Error(`get_quote failed (${res.status}): ${truncate(json)}`)
  }
  return json
}

/** Cap on the fullAppData payload we relay (the live docs are well under 2KB). */
const MAX_FULL_APP_DATA_BYTES = 8192

export interface SubmitOrderParams {
  chainId: number
  /** The order object returned by build_order (its `appData` is the hash). */
  order: BuiltOrder['order']
  /** The owner's EIP-712 signature over the order. */
  signature: string
  signingScheme?: 'eip712' | 'ethsign'
  from: Address
  /** The exact fullAppData string from build_order (the orderbook re-hashes it). */
  fullAppData: string
  /**
   * Required to relay an order whose receiver is NOT the owner. Off by default:
   * refusing to forward a drain-capable signed order is the relay's job, even
   * though the signature already commits to the receiver. Mirrors build_order's
   * unsafeCustomReceiver — a deliberate, named opt-in.
   */
  allowCustomReceiver?: boolean
}

/** Relays a PRE-SIGNED order to the chain's orderbook (`POST /api/v1/orders`). The MCP never signs. */
export async function submitOrder(p: SubmitOrderParams, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const chainId = assertChain(p.chainId)
  const from = checksum(p.from, 'from')
  if (!p.signature || !/^0x[0-9a-fA-F]+$/.test(p.signature)) throw new Error('submit_order: signature must be 0x-hex')

  // Re-validate every field we relay — submit_order is a public entry point in
  // its own right, not just a passthrough for trusted build_order output.
  const o = p.order
  const sellToken = checksum(o.sellToken, 'order.sellToken')
  const buyToken = checksum(o.buyToken, 'order.buyToken')
  const receiver = checksum(o.receiver, 'order.receiver')
  assertAtoms(o.sellAmount, 'order.sellAmount')
  assertAtoms(o.buyAmount, 'order.buyAmount')
  assertFeeAtoms(o.feeAmount, 'order.feeAmount')
  if (!Number.isInteger(o.validTo) || o.validTo <= 0 || o.validTo > 0xffffffff) {
    throw new Error(`submit_order: order.validTo must be a uint32, got ${o.validTo}`)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.appData)) throw new Error('submit_order: order.appData must be a 0x bytes32 hash')

  // Defence in depth: refuse to relay a non-owner receiver unless explicitly acked.
  assertReceiverIsOwner(from, receiver, { allowCustomReceiver: p.allowCustomReceiver === true })

  // The fullAppData MUST hash to the signed order.appData, else the orderbook
  // rejects it anyway — fail fast with a clear message and don't relay a mismatch.
  if (typeof p.fullAppData !== 'string' || p.fullAppData.length > MAX_FULL_APP_DATA_BYTES) {
    throw new Error(`submit_order: fullAppData missing or exceeds ${MAX_FULL_APP_DATA_BYTES} bytes`)
  }
  const computed = keccak256(toBytes(p.fullAppData))
  if (computed.toLowerCase() !== o.appData.toLowerCase()) {
    throw new Error(`submit_order: fullAppData does not hash to order.appData (${computed} != ${o.appData})`)
  }

  const body: Record<string, unknown> = {
    sellToken,
    buyToken,
    receiver,
    sellAmount: o.sellAmount,
    buyAmount: o.buyAmount,
    validTo: o.validTo,
    feeAmount: o.feeAmount,
    kind: o.kind,
    partiallyFillable: o.partiallyFillable,
    sellTokenBalance: o.sellTokenBalance,
    buyTokenBalance: o.buyTokenBalance,
    // OrderCreation: `appData` carries the full JSON string; `appDataHash` is
    // the signed bytes32. The backend recomputes keccak256(appData) and checks
    // it equals appDataHash (and the value signed into the order).
    appData: p.fullAppData,
    appDataHash: o.appData,
    signingScheme: p.signingScheme ?? 'eip712',
    signature: p.signature,
    from,
  }
  const url = `${getOphisOrderbookUrl(chainId)}/api/v1/orders`
  const res = await timedFetch(
    fetchImpl,
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    TIMEOUT_MS.orderbook,
    'submit_order',
  )
  const json = await res.json()
  if (!res.ok) throw new Error(`submit_order failed (${res.status}): ${truncate(json)}`)
  return json // the order UID (string) on success
}

export interface TierStatus {
  wallet: Address
  /** Live status from the rebate indexer (rebates.ophis.fi), or null if unavailable. */
  indexer: unknown
  /** The static tier ladder for context. */
  tiers: readonly Tier[]
}

/** Looks up a wallet's fee-rebate tier/status from the live rebate indexer. */
export async function lookupTier(wallet: Address, fetchImpl: typeof fetch = fetch): Promise<TierStatus> {
  const w = checksum(wallet, 'wallet')
  let indexer: unknown = null
  try {
    const res = await timedFetch(
      fetchImpl,
      `${REBATE_API}/tier/${w}`,
      { headers: { accept: 'application/json' } },
      TIMEOUT_MS.rebate,
      'lookup_tier',
    )
    indexer = res.ok ? await res.json() : { error: `rebate indexer ${res.status}` }
  } catch (e) {
    indexer = { error: `rebate indexer unreachable: ${(e as Error).message}` }
  }
  return { wallet: w, indexer, tiers: TIERS }
}

export interface ChainInfo {
  chainId: number
  name: string
  ophisOperated: boolean
  orderbookUrl: string | null
  settlement: Address | null
  partnerFee: OphisPartnerFee | null
}

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  100: 'Gnosis',
  137: 'Polygon',
  999: 'HyperEVM',
  4326: 'MegaETH',
  8453: 'Base',
  9745: 'Plasma',
  42161: 'Arbitrum One',
  43114: 'Avalanche',
  57073: 'Ink',
  59144: 'Linea',
  11155111: 'Sepolia',
}

export interface PausedChain {
  chainId: number
  name: string
  ophisOperated: boolean
  settlement: Address | null
  /** Why the chain isn't usable yet. */
  reason: string
}

export interface ChainList {
  /** Chains you can quote/build/submit on right now (orderbook host is live). */
  tradeable: ChainInfo[]
  /**
   * Fee chains whose settlement contract is deployed but whose orderbook host
   * is NOT live yet (MegaETH, HyperEVM). get_quote / build_order throw for
   * these, so do not pick them — listed only for transparency.
   */
  paused: PausedChain[]
}

/**
 * Lists Ophis chains, split into `tradeable` (orderbook live — use these) and
 * `paused` (settlement deployed but no live orderbook — get_quote/build_order
 * would throw). Pure. Only ever route a chainId from `tradeable`.
 */
export function listChains(): ChainList {
  const ophisOperated = new Set<number>(Object.values(OPHIS_CHAIN_IDS))
  const tradeable: ChainInfo[] = []
  const paused: PausedChain[] = []
  for (const chainId of [...OPHIS_FEE_CHAIN_IDS].sort((a, b) => a - b)) {
    const name = CHAIN_NAMES[chainId] ?? `chain-${chainId}`
    const settlement = OPHIS_SETTLEMENT_ADDRESSES[chainId] ?? null
    const orderbookUrl = OPHIS_ORDERBOOK_URLS[chainId] ?? null
    if (orderbookUrl) {
      tradeable.push({
        chainId,
        name,
        ophisOperated: ophisOperated.has(chainId),
        orderbookUrl,
        settlement,
        partnerFee: ophisDefaultPartnerFee(chainId) ?? null,
      })
    } else {
      paused.push({
        chainId,
        name,
        ophisOperated: ophisOperated.has(chainId),
        settlement,
        reason: 'orderbook host not live yet (settlement deployed) — get_quote/build_order will throw for this chain',
      })
    }
  }
  return { tradeable, paused }
}

// --- internal guards -------------------------------------------------------

function assertChain(chainId: number): number {
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`invalid chainId: ${chainId}`)
  return chainId
}

function checksum(addr: string, label: string): Address {
  if (!isAddress(addr)) throw new Error(`${label}: not a valid address (${addr})`)
  return getAddress(addr)
}

// Order amounts are uint256 on-chain; reject anything outside that range so
// build_order never returns an un-signable / orderbook-rejected order (#608 review).
const MAX_UINT256 = (1n << 256n) - 1n

// Hard cap on accepted slippage (50%). Above this a "limit" almost certainly
// reflects a mistake or a crafted self-fleecing order, not a real trade.
const MAX_SLIPPAGE_BIPS = 5000

function assertAtoms(amount: string, label: string): void {
  if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount) || amount === '0') {
    throw new Error(`${label}: must be a positive integer string of atoms (wei-like), got "${amount}"`)
  }
  if (BigInt(amount) > MAX_UINT256) throw new Error(`${label}: exceeds uint256 max, got "${amount}"`)
}

/** Like assertAtoms but allows "0" (feeAmount is 0 for modern CoW market orders). */
function assertFeeAtoms(amount: string, label: string): void {
  if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
    throw new Error(`${label}: must be a non-negative integer string of atoms, got "${amount}"`)
  }
  if (BigInt(amount) > MAX_UINT256) throw new Error(`${label}: exceeds uint256 max, got "${amount}"`)
}

/**
 * Cap slippageBips at MAX_SLIPPAGE_BIPS (50%). build_order does NOT enforce the
 * signed limit against a price oracle: it has no trusted quote, and a
 * CALLER-supplied reference is fakeable on this public no-auth tool (a
 * prompt-injected agent would pass buyAmount:"1", reference:"1") — so it is not a
 * trust boundary (reviewer P1). The limit amounts are the caller/signer's
 * responsibility; fund safety comes from the unconditionally-pinned receiver
 * (proceeds can only reach the owner) plus CoW returning surplus to the trader.
 * A real slippage guard would require build_order to fetch + bound against a
 * trusted quote here (a network dependency); tracked as a follow-up.
 */
function assertSlippageCap(p: BuildOrderParams): void {
  const slip = p.slippageBips
  if (slip !== undefined && (!Number.isInteger(slip) || slip < 0 || slip > MAX_SLIPPAGE_BIPS)) {
    throw new Error(`slippageBips must be an integer in [0, ${MAX_SLIPPAGE_BIPS}] (<=50%), got ${slip}`)
  }
}

/** Cap reflected upstream error bodies so attacker/upstream-controlled text can't flood agent context. */
function truncate(value: unknown, max = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export { assignTier }
