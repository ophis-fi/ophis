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
import {
  keccak256,
  toBytes,
  isAddress,
  getAddress,
  createPublicClient,
  http,
  fallback,
  formatUnits,
  parseAbi,
} from 'viem'

import {
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  buildOphisAppDataPartnerFee,
  buildOphisFullAppData,
  normalizeOphisReferralCode,
  assertReceiverIsOwner,
  ophisDefaultPartnerFee,
  OPHIS_STABLE_VOLUME_FEE_BPS,
  isZeroAddress,
  OPHIS_CHAIN_IDS,
  OPHIS_FEE_CHAIN_IDS,
  OPHIS_ORDERBOOK_URLS,
  OPHIS_SETTLEMENT_ADDRESSES,
  assertChain,
  checksum,
  assertAtoms,
  assertFeeAtoms,
  extractQuoteAmounts,
  assignTier,
  TIERS,
  type Address,
  type BuiltOrder,
  type OphisOrderDomain,
  type OphisPartnerFee,
  type Tier,
} from '@ophis/sdk'

// The pure order-build core lives in @ophis/sdk (packages/sdk/src/order-build.ts)
// since WP0 of the Odos extraction program. Re-export it under the original names
// (buildOphisFullAppData was buildOphisAppData here) so every existing import from
// './ophis.js' (tools.ts, tests/ophis.test.ts) compiles unchanged; behavior is
// identical, only the file location shifted.
export {
  APP_DATA_VERSION,
  ORDER_TYPED_DATA_TYPES,
  deterministicStringify,
  buildOphisFullAppData as buildOphisAppData,
  buildOrder,
  extractQuoteAmounts,
  assertLimitWithinSlippage,
  type Address,
  type OphisAppData,
  type BuildOrderParams,
  type BuiltOrder,
} from '@ophis/sdk'

// --- validate_order: pure offline preflight --------------------------------

/**
 * CoW Protocol's canonical GPv2Settlement. On the Ophis-operated chains the
 * deployed settlement is a DIFFERENT contract, so an EIP-712 domain built on
 * this address there is rejected by the deployed contract (every signature
 * fails validation). validateOrder names this failure mode explicitly.
 */
const COW_CANONICAL_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Minimum non-stable Volume bps the Ophis self-hosted (OP-stack) backend accepts
 * for a partner fee to the Ophis recipient: the anti-zero-bypass floor
 * OPHIS_NON_STABLE_FLOOR_BPS in apps/backend/crates/app-data/src/app_data.rs.
 * Same-chain stablecoin (or boosted) pairs floor at OPHIS_STABLE_VOLUME_FEE_BPS
 * (1 bp) instead. This offline preflight has no cheap stablecoin list, so it
 * applies the conservative non-stable floor and names the reduced stable-pair
 * floor in the error. Not exported by the SDK (Rust-only constant), so it is
 * mirrored here; keep in lockstep with app_data.rs.
 */
const OPHIS_NON_STABLE_FLOOR_BPS = 4

/**
 * Normalizes an orderbook base URL to `origin + pathname` (lowercased, a single
 * trailing slash stripped) so two base URLs compare equal regardless of a
 * trailing slash. Compared over the FULL base, not just the host: CoW serves
 * every hosted chain under one host (api.cow.fi) and selects the chain by PATH
 * (api.cow.fi/mainnet vs api.cow.fi/xdai), so a host-only check accepts the
 * wrong chain's orderbook.
 */
function normalizeOrderbookBase(u: URL): string {
  return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase()
}

export interface ValidateOrderParams {
  chainId: number
  /** The signing account. Enables the receiver-pinning drain-guard check. */
  owner?: string
  /** The (partial) order about to be signed. `appData` is the signed bytes32 hash. */
  order?: {
    receiver?: string
    appData?: string
    validTo?: number
    sellAmount?: string
    buyAmount?: string
    sellToken?: string
    buyToken?: string
    feeAmount?: string
    kind?: string
  }
  /** The exact appData JSON string that will be submitted with the order. */
  fullAppData?: string
  /** The EIP-712 domain the order will be signed against. */
  signingDomain?: { name?: string; version?: string; chainId?: number; verifyingContract?: string }
  /** The orderbook base URL the order will be submitted to. */
  orderbookUrl?: string
}

/** The correct per-chain wiring, echoed back so a caller can fix mismatches. */
export interface ValidateOrderExpected {
  chainId: number
  orderbookUrl: string | null
  settlement: Address | null
  signingDomain: OphisOrderDomain | null
  appCode: 'ophis'
  partnerFee: OphisPartnerFee | null
}

export interface ValidateOrderResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  expected: ValidateOrderExpected
}

/**
 * Pure offline preflight for an order built OUTSIDE build_order. Collects every
 * failure in one pass (errors = will not settle or will lose funds/attribution;
 * warnings = settles but degraded) and echoes the correct per-chain wiring in
 * `expected`. No network calls, no keys. The checks target the documented
 * silent failure modes: wrong appCode, wrong orderbook host, wrong EIP-712
 * domain, appData hash mismatch, unpinned receiver, expired validTo, non-zero
 * signed feeAmount, malformed amounts. Reuses the same per-chain helpers as
 * buildOrder (no duplicated constants).
 */
export function validateOrder(p: ValidateOrderParams, nowSeconds: number): ValidateOrderResult {
  const errors: string[] = []
  const warnings: string[] = []
  const chainId = p.chainId
  const chainIdOk = typeof chainId === 'number' && Number.isInteger(chainId) && chainId > 0

  // (1) The chain must be tradeable right now (same source of truth as list_chains).
  const tradeableIds = listChains().tradeable.map((c) => c.chainId)
  if (!chainIdOk) {
    errors.push(`invalid chainId: ${chainId}. Tradeable chain ids: ${tradeableIds.join(', ')}.`)
  } else if (!tradeableIds.includes(chainId)) {
    errors.push(
      `chainId ${chainId} is not tradeable on Ophis (no live orderbook host). Tradeable chain ids: ${tradeableIds.join(', ')}.`,
    )
  }

  // (2) The correct wiring for this chain, via the same helpers buildOrder uses.
  const settlement = (chainIdOk ? OPHIS_SETTLEMENT_ADDRESSES[chainId] : undefined) ?? null
  const expected: ValidateOrderExpected = {
    chainId,
    orderbookUrl: (chainIdOk ? OPHIS_ORDERBOOK_URLS[chainId] : undefined) ?? null,
    settlement,
    signingDomain: settlement ? getOphisOrderDomain(chainId) : null,
    appCode: 'ophis',
    partnerFee: (chainIdOk ? buildOphisAppDataPartnerFee(chainId) : undefined) ?? null,
  }
  const ophisOperated = chainIdOk && new Set<number>(Object.values(OPHIS_CHAIN_IDS)).has(chainId)

  // (3) EIP-712 signing domain, field by field against the correct per-chain domain.
  if (p.signingDomain !== undefined && expected.signingDomain) {
    const d = p.signingDomain
    const exp = expected.signingDomain
    if (d.name !== exp.name) {
      errors.push(`signingDomain.name must be "${exp.name}", got ${JSON.stringify(d.name)}.`)
    }
    if (d.version !== exp.version) {
      errors.push(`signingDomain.version must be "${exp.version}", got ${JSON.stringify(d.version)}.`)
    }
    if (d.chainId !== exp.chainId) {
      errors.push(`signingDomain.chainId must be ${exp.chainId}, got ${d.chainId}.`)
    }
    const vc = d.verifyingContract
    if (typeof vc !== 'string' || vc.toLowerCase() !== exp.verifyingContract.toLowerCase()) {
      if (
        typeof vc === 'string' &&
        vc.toLowerCase() === COW_CANONICAL_SETTLEMENT.toLowerCase() &&
        exp.verifyingContract.toLowerCase() !== COW_CANONICAL_SETTLEMENT.toLowerCase()
      ) {
        errors.push(
          `signingDomain.verifyingContract is CoW Protocol's canonical settlement ${COW_CANONICAL_SETTLEMENT}, but chain ${chainId} is Ophis-operated and settles on Ophis's own deployed contract: signing against the canonical address produces an EIP-712 domain separator the deployed contract rejects, so every signature fails validation. Sign against ${exp.verifyingContract}.`,
        )
      } else {
        errors.push(
          `signingDomain.verifyingContract must be ${exp.verifyingContract} on chain ${chainId}, got ${JSON.stringify(vc)}.`,
        )
      }
    }
  }

  // (4) Orderbook base URL. api.cow.fi does not serve the Ophis-operated chains,
  // and CoW selects the hosted chain by PATH under one host, so this compares the
  // FULL normalized base (origin + path), not just the host.
  if (p.orderbookUrl !== undefined) {
    let givenUrl: URL | null = null
    try {
      givenUrl = new URL(p.orderbookUrl)
    } catch {
      errors.push(`orderbookUrl is not a valid URL: ${JSON.stringify(p.orderbookUrl)}.`)
    }
    if (givenUrl !== null && expected.orderbookUrl) {
      const givenHost = givenUrl.host.toLowerCase()
      if (givenHost === 'api.cow.fi' && ophisOperated) {
        errors.push(
          `orderbookUrl points at api.cow.fi, but chain ${chainId} is Ophis-operated: that host does not serve the Ophis stack, so the order silently bypasses the Ophis solvers and partner fee. Submit to ${expected.orderbookUrl}.`,
        )
      } else if (normalizeOrderbookBase(givenUrl) !== normalizeOrderbookBase(new URL(expected.orderbookUrl))) {
        errors.push(
          `orderbookUrl ${p.orderbookUrl} is wrong for chain ${chainId}; the correct orderbook is ${expected.orderbookUrl}. CoW serves every hosted chain under api.cow.fi and selects the chain by path, so a matching host alone is not enough.`,
        )
      }
    }
  }

  const o = p.order

  // (5) fullAppData: parseability, appCode, partnerFee, referral code, hash link.
  if (p.fullAppData !== undefined) {
    let doc: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(p.fullAppData)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>
      } else {
        errors.push('fullAppData must be a JSON object document; the orderbook rejects anything else.')
      }
    } catch {
      errors.push('fullAppData is not valid JSON; the orderbook rejects unparseable appData.')
    }
    if (doc) {
      if (doc.appCode !== 'ophis') {
        warnings.push(
          `appData appCode is ${JSON.stringify(doc.appCode)} instead of "ophis": the order still settles and pays the partner fee, but the rebate indexer attributes zero rebate/affiliate volume for it, silently. Use build_order or set appCode to "ophis".`,
        )
      }
      const metadata = (doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}) as Record<string, unknown>
      const partnerFee = metadata.partnerFee
      if (partnerFee === undefined) {
        warnings.push(
          'appData metadata.partnerFee is absent: the order carries no Ophis fee and earns no rebate or affiliate attribution. Ophis integrations normally embed it; use build_order, which adds the correct partnerFee for the chain.',
        )
      } else {
        const entries = Array.isArray(partnerFee) ? partnerFee : [partnerFee]
        // The recipient the backend allowlist gates on (app_data.rs
        // PARTNER_FEE_RECIPIENT_ALLOWLIST). Sourced from expected.partnerFee, the
        // per-chain fee config already computed above via the same SDK helper
        // buildOrder uses, so there is no second copy of the address here.
        const ophisRecipient = expected.partnerFee?.recipient?.toLowerCase()
        let ophisRecipientSeen = false
        entries.forEach((entry: unknown, i: number) => {
          const label = Array.isArray(partnerFee) ? `appData metadata.partnerFee[${i}]` : 'appData metadata.partnerFee'
          const fee = (entry && typeof entry === 'object' ? entry : {}) as { recipient?: unknown; volumeBps?: unknown }
          const recipientOk = typeof fee.recipient === 'string' && ADDRESS_RE.test(fee.recipient)
          if (!recipientOk) {
            errors.push(`${label}.recipient must be a 0x-prefixed 40-hex-char address, got ${JSON.stringify(fee.recipient)}.`)
          }
          const volumeBpsOk =
            typeof fee.volumeBps === 'number' &&
            Number.isInteger(fee.volumeBps) &&
            fee.volumeBps >= 1 &&
            fee.volumeBps <= 100
          if (!volumeBpsOk) {
            errors.push(`${label}.volumeBps must be an integer in [1, 100], got ${JSON.stringify(fee.volumeBps)}.`)
          }
          // The backend allowlist (app_data.rs validate_partner_fees) gates EVERY
          // entry: it rejects the WHOLE order if ANY recipient is not in
          // PARTNER_FEE_RECIPIENT_ALLOWLIST, which today holds only the Ophis Safe.
          const isOphisRecipient =
            recipientOk && ophisRecipient !== undefined && (fee.recipient as string).toLowerCase() === ophisRecipient
          if (isOphisRecipient) {
            ophisRecipientSeen = true
            // Token-pair Volume floor, enforced ONLY on Ophis-operated chains (the
            // self-hosted backend applies partner_fee_floor_bps; CoW-hosted chains do
            // not). The preflight has no cheap stablecoin list, so it applies the
            // conservative non-stable floor and names the reduced stable-pair floor.
            const tokensGiven = typeof o?.sellToken === 'string' && typeof o?.buyToken === 'string'
            if (ophisOperated && volumeBpsOk && tokensGiven && (fee.volumeBps as number) < OPHIS_NON_STABLE_FLOOR_BPS) {
              errors.push(
                `${label}.volumeBps ${fee.volumeBps} is below the Ophis ${OPHIS_NON_STABLE_FLOOR_BPS}-bps non-stable Volume floor on Ophis-operated chain ${chainId}: the self-hosted backend rejects a fee to the Ophis recipient under this floor. Same-chain stablecoin pairs floor at ${OPHIS_STABLE_VOLUME_FEE_BPS} bp; raise volumeBps to at least ${OPHIS_NON_STABLE_FLOOR_BPS} (or ${OPHIS_STABLE_VOLUME_FEE_BPS} for a same-chain stable pair).`,
              )
            } else if (ophisOperated && volumeBpsOk && !tokensGiven && (fee.volumeBps as number) < OPHIS_NON_STABLE_FLOOR_BPS) {
              // Tokens omitted, so the pair (and thus the exact floor) cannot be
              // confirmed here; the backend still enforces it. Warn rather than
              // silently pass, so omitting the tokens does not hide a floor breach.
              warnings.push(
                `${label}.volumeBps ${fee.volumeBps} may breach the Ophis Volume floor (${OPHIS_NON_STABLE_FLOOR_BPS} bps non-stable, ${OPHIS_STABLE_VOLUME_FEE_BPS} bp same-chain stable) on Ophis-operated chain ${chainId}; supply sellToken/buyToken so the preflight can confirm, or the backend may reject the order at ingress.`,
              )
            }
          } else if (recipientOk && ophisOperated) {
            // A non-Ophis recipient on an Ophis-operated chain. validate_partner_fees
            // rejects the ENTIRE order if ANY recipient is not allowlisted, and only
            // the Ophis Safe is allowlisted by default. This preflight cannot see the
            // backend allowlist, so it treats any non-Ophis recipient as rejected and
            // ERRORS (not just warns): a caller that gates on valid must NOT sign an
            // order the backend rejects at ingress. If the recipient is an already
            // allowlisted partner Safe, submit directly to confirm.
            errors.push(
              `${label}.recipient ${fee.recipient} is not the Ophis recipient. On Ophis-operated chain ${chainId} the backend partner-fee allowlist rejects the whole order unless this address is in PARTNER_FEE_RECIPIENT_ALLOWLIST (only the Ophis recipient is allowlisted by default); an integrator own-fee recipient must be independently verified and allowlisted first. Own-fee stacking is not open by default on the sovereign chains.`,
            )
          }
        })
        // The Ophis recipient MUST appear on a fee chain: the backend allowlist
        // (app_data.rs validate_partner_fees) rejects a partner fee whose recipient
        // is not the Ophis Safe, so a document carrying only a foreign recipient
        // routes nothing to Ophis and is rejected at ingress. A stacked foreign
        // entry (an integrator's own fee) is NOT accepted by default either: it is
        // warned about above, because the backend rejects the whole order unless
        // that recipient is independently allowlisted.
        if (expected.partnerFee && !ophisRecipientSeen) {
          errors.push(
            `appData metadata.partnerFee has no entry paying the Ophis recipient ${expected.partnerFee.recipient} on fee chain ${chainId}: the backend partner-fee allowlist rejects a fee to any other recipient, so this order earns no Ophis fee and is rejected at ingress. Set the Ophis fee entry's recipient to ${expected.partnerFee.recipient}.`,
          )
        }
      }
      if (metadata.ophisReferrer !== undefined) {
        const code = (metadata.ophisReferrer as { code?: unknown } | null)?.code
        if (typeof code !== 'string') {
          errors.push(`appData metadata.ophisReferrer.code must be a string, got ${JSON.stringify(code)}.`)
        } else {
          // The rebate indexer TRIMS + LOWERCASES the code before matching
          // (apps/rebate-indexer/src/fetcher.ts), so a non-canonical-but-normalizable
          // code (e.g. "ACME-Bot_1" or one with surrounding spaces) IS creditable.
          // Validate the NORMALIZED form via the same SDK helper (which trims,
          // lowercases, then grammar-checks, mirroring the indexer); only error if the
          // code cannot be normalized into a valid registry code at all.
          try {
            normalizeOphisReferralCode(code)
          } catch (e) {
            errors.push(`appData metadata.ophisReferrer.code ${JSON.stringify(code)} is invalid: ${(e as Error).message}`)
          }
        }
      }
    }
  }

  // (5b) The signed bytes32 must be the keccak256 of the EXACT submitted string.
  if (o?.appData !== undefined && !BYTES32_RE.test(o.appData)) {
    errors.push(`order.appData must be a 0x bytes32 hash (keccak256 of fullAppData), got ${JSON.stringify(o.appData)}.`)
  } else if (o?.appData !== undefined && p.fullAppData !== undefined) {
    const computed = keccak256(toBytes(p.fullAppData))
    if (computed.toLowerCase() !== o.appData.toLowerCase()) {
      errors.push(
        `fullAppData does not hash to order.appData: keccak256(fullAppData) = ${computed} but order.appData = ${o.appData}. The orderbook hashes the EXACT submitted string, so any re-serialization (key order, whitespace, version bump) silently changes the hash and the orderbook rejects the order. Submit the byte-identical string that was hashed into the signed order.`,
      )
    }
  }

  // (6) Receiver pinning: undefined, zero, or the owner. Mirrors submit_order,
  // which refuses to relay a non-owner receiver (the drain guard).
  const ownerOk = p.owner !== undefined && ADDRESS_RE.test(p.owner)
  if (p.owner !== undefined && !ownerOk) {
    errors.push(`owner must be a 0x-prefixed 40-hex-char address, got ${JSON.stringify(p.owner)}.`)
  }
  if (o?.receiver !== undefined) {
    if (!ADDRESS_RE.test(o.receiver)) {
      errors.push(`order.receiver must be a 0x-prefixed 40-hex-char address, got ${JSON.stringify(o.receiver)}.`)
    } else if (!isZeroAddress(o.receiver)) {
      if (ownerOk) {
        if (o.receiver.toLowerCase() !== (p.owner as string).toLowerCase()) {
          errors.push(
            `order.receiver ${o.receiver} is not the owner ${p.owner}: proceeds would leave the account (the receiver-pinning drain guard; submit_order refuses to relay this). Set receiver to the owner or the zero address.`,
          )
        }
      } else {
        warnings.push(
          'order.receiver is set but no valid owner was given, so the receiver-pinning drain guard could not be checked; pass owner to verify proceeds return to the signing account.',
        )
      }
    }
  }

  // (7) Lifetime sanity at nowSeconds.
  if (o?.validTo !== undefined) {
    const now = Math.floor(nowSeconds)
    if (!Number.isInteger(o.validTo) || o.validTo <= 0 || o.validTo > 0xffffffff) {
      errors.push(`order.validTo must be a uint32 unix timestamp, got ${o.validTo}.`)
    } else if (o.validTo <= now) {
      errors.push(`order.validTo ${o.validTo} is already expired (now = ${now}); the orderbook rejects expired orders.`)
    } else if (o.validTo < now + 60) {
      errors.push(
        `order.validTo ${o.validTo} expires in ${o.validTo - now}s (under 60s): it will likely expire before settlement. Rebuild with a longer lifetime.`,
      )
    } else if (o.validTo > now + 7 * 24 * 3600) {
      warnings.push(
        `order.validTo ${o.validTo} is more than 7 days out: a long-lived limit can execute at a stale price. Confirm the lifetime is intentional.`,
      )
    }
  }

  // (8) Signed feeAmount must be 0, the same policy build_order enforces: the
  // Ophis fee is taken via the appData partner fee (from the trade output at
  // settlement), not a signed feeAmount, and CoW accounting treats a signed
  // feeAmount as ADDITIONAL sell-token spend no slippage check covers.
  if (o?.feeAmount !== undefined && o.feeAmount !== '0') {
    errors.push(
      `order.feeAmount must be "0", got ${JSON.stringify(o.feeAmount)}: Ophis orders take the fee via the appData partner fee, not a signed feeAmount; a non-zero signed feeAmount is additional sell-token spend that no slippage check covers.`,
    )
  }

  // (9) Amounts must be positive uint256 decimal strings.
  for (const [field, value] of [
    ['sellAmount', o?.sellAmount],
    ['buyAmount', o?.buyAmount],
  ] as const) {
    if (value !== undefined) {
      try {
        assertAtoms(value, `order.${field}`)
      } catch (e) {
        errors.push((e as Error).message)
      }
    }
  }

  // Light shape checks on the remaining order fields callers may pass.
  for (const [field, value] of [
    ['sellToken', o?.sellToken],
    ['buyToken', o?.buyToken],
  ] as const) {
    if (value !== undefined && !ADDRESS_RE.test(value)) {
      errors.push(`order.${field} must be a 0x-prefixed 40-hex-char address, got ${JSON.stringify(value)}.`)
    }
  }
  if (o?.kind !== undefined && o.kind !== 'sell' && o.kind !== 'buy') {
    errors.push(`order.kind must be "sell" or "buy", got ${JSON.stringify(o.kind)}.`)
  }

  return { valid: errors.length === 0, errors, warnings, expected }
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
  /** Absolute order expiry (unix seconds). When set, the quote is requested for this EXACT
   *  validTo rather than a relative window, so the enforcement quote matches the signed
   *  order's lifetime even across quote-fetch latency. Takes precedence over validForSeconds. */
  validTo?: number
}

/** Fetches a quote from the chain's Ophis orderbook (`POST /api/v1/quote`). Returns the raw orderbook response. */
export async function getQuote(p: QuoteParams, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const chainId = assertChain(p.chainId)
  const from = checksum(p.from, 'from')
  const sellToken = checksum(p.sellToken, 'sellToken')
  const buyToken = checksum(p.buyToken, 'buyToken')
  assertAtoms(p.amount, 'amount')
  const { fullAppData, appDataHash } = buildOphisFullAppData(chainId)
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
    // Quote for the EXACT order lifetime when an absolute validTo is supplied: a relative
    // validFor re-anchors to the orderbook's request-receive time (later than buildOrder's
    // local now), so it would price a slightly longer-lived order than the one being signed.
    ...(p.validTo !== undefined ? { validTo: p.validTo } : { validFor: p.validForSeconds ?? 1200 }),
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

/** Grammar for an integrator appCode / referral code (mirrors the rebate indexer). */
const APP_CODE_RE = /^[a-z0-9_-]{3,64}$/

export interface IntegratorEarnings {
  appCode: string
  /** The live earnings payload from the rebate indexer (rebates.ophis.fi/earnings/:appCode),
   *  or an { error } wrapper when the indexer is unreachable / non-200. */
  earnings: unknown
}

/**
 * Looks up what an integrator's own-fee routing earned, by appCode, from the live
 * rebate indexer's keyless GET /earnings/:appCode. The payload splits routed volume by
 * chain and by sovereign (Optimism, Unichain) vs CoW-hosted, and reports the Ophis base
 * fee, the integrator's OWN stacked fee, and the referral rebate paid-to-date with
 * payout tx links. Guaranteed/paid figures are scoped to the Ophis-operated chains; the
 * response carries a `disclaimer` describing the CoW-hosted accrual. Read-only, keyless.
 */
export async function getIntegratorEarnings(appCode: string, fetchImpl: typeof fetch = fetch): Promise<IntegratorEarnings> {
  const code = String(appCode).trim().toLowerCase()
  if (!APP_CODE_RE.test(code)) throw new Error('get_integrator_earnings: appCode must be 3-64 chars of [a-z0-9_-]')
  let earnings: unknown = null
  try {
    const res = await timedFetch(
      fetchImpl,
      `${REBATE_API}/earnings/${code}`,
      { headers: { accept: 'application/json' } },
      TIMEOUT_MS.rebate,
      'get_integrator_earnings',
    )
    earnings = res.ok ? await res.json() : { error: `rebate indexer ${res.status}` }
  } catch (e) {
    earnings = { error: `rebate indexer unreachable: ${(e as Error).message}` }
  }
  return { appCode: code, earnings }
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
  130: 'Unichain',
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

/** Cap reflected upstream error bodies so attacker/upstream-controlled text can't flood agent context. */
function truncate(value: unknown, max = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export { assignTier }

// ---------------------------------------------------------------------------
// Agent data tools: balances, portfolio, gas, OHLCV chart, expected surplus.
//
// All READ-ONLY and keyless. They never sign, never move funds, and never
// touch the order-building surface — they only read public chain state (viem
// over keyless public RPCs), the keyless GeckoTerminal market API, and the
// same Ophis orderbook + a public DEX aggregator. So they stay strictly inside
// the existing "no keys, read-only" trust boundary; the only new resource is
// outbound RPC/HTTP, already bounded by per-call timeouts.
// ---------------------------------------------------------------------------

/** Multicall3 — same canonical address on every chain Ophis serves. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** Native gas-token symbol per chain (all 18-decimal). For display only. */
const NATIVE_SYMBOL: Record<number, string> = {
  1: 'ETH', 10: 'ETH', 56: 'BNB', 100: 'xDAI', 137: 'POL', 999: 'HYPE',
  4326: 'ETH', 8453: 'ETH', 9745: 'XPL', 42161: 'ETH', 43114: 'AVAX',
  57073: 'ETH', 59144: 'ETH', 11155111: 'ETH',
}

/**
 * Keyless public RPC endpoints per chain (PublicNode primary, LlamaRPC fallback
 * where available). Used ONLY for read calls (getBalance / multicall / gas). An
 * operator can override or extend via OphisToolConfig.rpcUrls. Chains not listed
 * here return a clear "no public RPC" error rather than guessing an endpoint.
 */
const PUBLIC_RPCS: Record<number, string[]> = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
  10: ['https://optimism-rpc.publicnode.com', 'https://optimism.llamarpc.com'],
  56: ['https://bsc-rpc.publicnode.com', 'https://binance.llamarpc.com'],
  100: ['https://gnosis-rpc.publicnode.com'],
  130: ['https://mainnet.unichain.org'],
  137: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.llamarpc.com'],
  8453: ['https://base-rpc.publicnode.com', 'https://base.llamarpc.com'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.llamarpc.com'],
  43114: ['https://avalanche-c-chain-rpc.publicnode.com'],
  57073: ['https://rpc-gel.inkonchain.com'],
  59144: ['https://linea-rpc.publicnode.com'],
}

/** GeckoTerminal network slug per chain (for the keyless OHLCV market API). */
const GECKO_NETWORK: Record<number, string> = {
  1: 'eth', 10: 'optimism', 56: 'bsc', 100: 'xdai', 130: 'unichain', 137: 'polygon_pos',
  8453: 'base', 42161: 'arbitrum', 43114: 'avax', 57073: 'ink', 59144: 'linea',
}

/** KyberSwap aggregator path-slug per chain (the public beat-the-market reference). */
const KYBER_SLUG: Record<number, string> = {
  1: 'ethereum', 10: 'optimism', 130: 'unichain', 56: 'bsc', 137: 'polygon', 8453: 'base',
  42161: 'arbitrum', 43114: 'avalanche', 59144: 'linea',
}

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

const RPC_TIMEOUT_MS = 8_000
const GECKO_TIMEOUT_MS = 10_000

/** Builds a viem PublicClient for a chain from the keyless RPC map (or override). */
function publicClient(chainId: number, rpcUrls?: Record<number, string>) {
  const override = rpcUrls?.[chainId]
  const urls = override ? [override] : PUBLIC_RPCS[chainId]
  if (!urls || urls.length === 0) {
    throw new Error(`no public RPC configured for chain ${chainId} — pass an rpcUrl override`)
  }
  // Minimal chain object: viem only needs the id + multicall3 address for the
  // calls these tools make (getBalance / multicall / gas). Native currency is
  // 18-dec on every Ophis chain.
  const chain = {
    id: chainId,
    name: CHAIN_NAMES[chainId] ?? `chain-${chainId}`,
    nativeCurrency: { name: NATIVE_SYMBOL[chainId] ?? 'ETH', symbol: NATIVE_SYMBOL[chainId] ?? 'ETH', decimals: 18 },
    rpcUrls: { default: { http: urls } },
    contracts: { multicall3: { address: MULTICALL3 } },
  } as const
  const transport =
    urls.length > 1 ? fallback(urls.map((u) => http(u, { timeout: RPC_TIMEOUT_MS }))) : http(urls[0], { timeout: RPC_TIMEOUT_MS })
  return createPublicClient({ chain: chain as never, transport })
}

export interface TokenBalance {
  token: Address
  symbol: string | null
  decimals: number | null
  /** Balance in atoms (uint256 decimal string). */
  raw: string
  /** Human-readable balance (raw / 10**decimals), or null if decimals unknown. */
  formatted: string | null
  /** Set when this token's read failed (the rest of the batch still returns). */
  error?: string
}

export interface BalancesResult {
  chainId: number
  owner: Address
  native: { symbol: string; decimals: 18; raw: string; formatted: string }
  tokens: TokenBalance[]
}

const MAX_TOKENS_PER_CALL = 50

/**
 * Reads the owner's native balance plus ERC-20 balances for the given tokens on
 * one chain, in a single multicall. Read-only. Token reads that revert (e.g. a
 * non-ERC20 address) are reported per-token with an `error` rather than failing
 * the whole call.
 */
export async function getBalances(
  p: { chainId: number; owner: Address; tokens?: string[]; rpcUrls?: Record<number, string> },
): Promise<BalancesResult> {
  const chainId = assertChain(p.chainId)
  const owner = checksum(p.owner, 'owner')
  const tokens = (p.tokens ?? []).map((t, i) => checksum(t, `tokens[${i}]`))
  if (tokens.length > MAX_TOKENS_PER_CALL) {
    throw new Error(`get_balances: at most ${MAX_TOKENS_PER_CALL} tokens per call, got ${tokens.length}`)
  }
  const client = publicClient(chainId, p.rpcUrls)

  const nativeRaw = await client.getBalance({ address: owner })
  const native = {
    symbol: NATIVE_SYMBOL[chainId] ?? 'ETH',
    decimals: 18 as const,
    raw: nativeRaw.toString(),
    formatted: formatUnits(nativeRaw, 18),
  }

  if (tokens.length === 0) return { chainId, owner, native, tokens: [] }

  // One multicall: balanceOf + decimals + symbol for each token (allowFailure so
  // a single bad token can't sink the batch).
  const contracts = tokens.flatMap((token) => [
    { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] } as const,
    { address: token, abi: ERC20_ABI, functionName: 'decimals' } as const,
    { address: token, abi: ERC20_ABI, functionName: 'symbol' } as const,
  ])
  const results = await client.multicall({ contracts, allowFailure: true })

  const out: TokenBalance[] = tokens.map((token, i) => {
    const bal = results[i * 3]
    const dec = results[i * 3 + 1]
    const sym = results[i * 3 + 2]
    if (bal.status !== 'success') {
      return { token, symbol: null, decimals: null, raw: '0', formatted: null, error: 'balanceOf reverted (not an ERC-20?)' }
    }
    const raw = (bal.result as bigint).toString()
    // Clamp decimals to a sane ERC-20 range: a hostile token can report e.g. 255,
    // which would make formatUnits emit a 250+ digit string straight into the
    // agent's context. 10**77 < 2**256, so >77 is never a real token decimals.
    const rawDec = dec.status === 'success' ? Number(dec.result as number) : null
    const decimals = rawDec !== null && Number.isInteger(rawDec) && rawDec >= 0 && rawDec <= 77 ? rawDec : null
    // Truncate symbol: symbol() can return arbitrary-length text (context flood).
    const symRaw = sym.status === 'success' ? (sym.result as string) : null
    const symbol = typeof symRaw === 'string' ? symRaw.slice(0, 32) : null
    return { token, symbol, decimals, raw, formatted: decimals !== null ? formatUnits(BigInt(raw), decimals) : null }
  })
  return { chainId, owner, native, tokens: out }
}

export interface PortfolioResult {
  owner: Address
  chains: Array<BalancesResult | { chainId: number; error: string }>
}

const MAX_PORTFOLIO_CHAINS = 12

// Hard cap on the TOTAL ERC-20 token reads fanned out across all chains in one
// call. Each chain already costs a native-balance read plus one multicall, so the
// chain cap bounds the base fan-out; this additionally bounds the token-driven
// multicall subrequests so one unauthenticated POST cannot be amplified into an
// unbounded number of upstream RPC subrequests.
const MAX_PORTFOLIO_TOKENS_TOTAL = 100

/**
 * Native + token balances for an owner across multiple chains. `tokensByChain`
 * maps a chainId to the token addresses to read on it (native is always
 * included). With no chains given it scans every chain that has a public RPC.
 * Per-chain failures are captured inline so one dead RPC can't sink the result.
 */
export async function getPortfolio(
  p: { owner: Address; chainIds?: number[]; tokensByChain?: Record<number, string[]>; rpcUrls?: Record<number, string> },
): Promise<PortfolioResult> {
  const owner = checksum(p.owner, 'owner')
  const chainIds = (p.chainIds && p.chainIds.length > 0 ? p.chainIds : Object.keys(PUBLIC_RPCS).map(Number))
    .filter((c) => PUBLIC_RPCS[c] || p.rpcUrls?.[c])
  if (chainIds.length > MAX_PORTFOLIO_CHAINS) {
    throw new Error(`get_portfolio: at most ${MAX_PORTFOLIO_CHAINS} chains per call, got ${chainIds.length}`)
  }
  // Bound the total token fan-out (across only the chains actually queried) so an
  // unauthenticated caller cannot amplify one POST into unbounded upstream RPC hits.
  const totalTokens = chainIds.reduce((sum, c) => sum + (p.tokensByChain?.[c]?.length ?? 0), 0)
  if (totalTokens > MAX_PORTFOLIO_TOKENS_TOTAL) {
    throw new Error(`get_portfolio: at most ${MAX_PORTFOLIO_TOKENS_TOTAL} token reads total across all chains, got ${totalTokens}`)
  }
  const chains = await Promise.all(
    chainIds.map(async (chainId) => {
      try {
        return await getBalances({ chainId, owner, tokens: p.tokensByChain?.[chainId], rpcUrls: p.rpcUrls })
      } catch (e) {
        return { chainId, error: (e as Error)?.message ?? String(e) }
      }
    }),
  )
  return { owner, chains }
}

export interface GasResult {
  chainId: number
  /** EIP-1559 fee suggestion in wei (when the chain supports it). */
  maxFeePerGas: string | null
  maxPriorityFeePerGas: string | null
  /** Legacy/effective gas price in wei. */
  gasPrice: string
  /** gasPrice expressed in gwei (human-readable). */
  gasPriceGwei: string
  nativeSymbol: string
  /** Ophis trades are gasless for the trader (the solver pays settlement gas);
   *  this number is mainly the cost of a one-time ERC-20 approval to the
   *  VaultRelayer for a first sell of a given token. */
  note: string
}

/** Current gas price for a chain (EIP-1559 suggestion when available, else legacy). */
export async function getGas(p: { chainId: number; rpcUrls?: Record<number, string> }): Promise<GasResult> {
  const chainId = assertChain(p.chainId)
  const client = publicClient(chainId, p.rpcUrls)
  let maxFeePerGas: bigint | null = null
  let maxPriorityFeePerGas: bigint | null = null
  try {
    const fees = await client.estimateFeesPerGas()
    maxFeePerGas = fees.maxFeePerGas ?? null
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? null
  } catch {
    // Non-1559 chain or estimation unsupported — fall back to legacy gasPrice.
  }
  const gasPrice = maxFeePerGas ?? (await client.getGasPrice())
  return {
    chainId,
    maxFeePerGas: maxFeePerGas?.toString() ?? null,
    maxPriorityFeePerGas: maxPriorityFeePerGas?.toString() ?? null,
    gasPrice: gasPrice.toString(),
    gasPriceGwei: formatUnits(gasPrice, 9),
    nativeSymbol: NATIVE_SYMBOL[chainId] ?? 'ETH',
    note: 'Ophis trades are gasless for the trader; this gas price mainly applies to a one-time ERC-20 approval to the VaultRelayer.',
  }
}

const GECKO_API = 'https://api.geckoterminal.com/api/v2'

export interface Candle {
  /** Candle open time (unix seconds). */
  t: number
  o: number
  h: number
  l: number
  c: number
  /** Quote-currency volume. */
  v: number
}
export interface TokenChartResult {
  chainId: number
  token: Address
  network: string
  /** The GeckoTerminal pool the OHLCV came from (deepest pool for the token). */
  pool: string | null
  timeframe: 'day' | 'hour' | 'minute'
  aggregate: number
  candles: Candle[]
}

const MAX_CANDLES = 300

/**
 * OHLCV price history for a token, from the keyless GeckoTerminal market API.
 * Resolves the token's deepest pool first, then pulls that pool's candles.
 * NOTE: GeckoTerminal's keyless tier is a shared ~30 req/min quota — agents
 * should cache and not poll this tightly.
 */
export async function getTokenChart(
  p: { chainId: number; token: Address; timeframe?: 'day' | 'hour' | 'minute'; aggregate?: number; limit?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenChartResult> {
  const chainId = assertChain(p.chainId)
  const token = checksum(p.token, 'token')
  const network = GECKO_NETWORK[chainId]
  if (!network) throw new Error(`get_token_chart: GeckoTerminal has no network mapping for chain ${chainId}`)
  const timeframe = p.timeframe ?? 'day'
  const aggregate = p.aggregate && p.aggregate > 0 ? Math.trunc(p.aggregate) : 1
  const limit = Math.min(Math.max(1, Math.trunc(p.limit ?? 30)), MAX_CANDLES)

  // 1. Find the token's deepest pool (GeckoTerminal sorts pools by liquidity).
  const poolsRes = await timedFetch(
    fetchImpl,
    `${GECKO_API}/networks/${network}/tokens/${token.toLowerCase()}/pools?page=1`,
    { headers: { accept: 'application/json' } },
    GECKO_TIMEOUT_MS,
    'get_token_chart',
  )
  if (!poolsRes.ok) throw new Error(`get_token_chart: pool lookup failed (${poolsRes.status})`)
  const poolsJson = (await poolsRes.json()) as { data?: Array<{ attributes?: { address?: string } }> }
  const poolAddr = poolsJson.data?.[0]?.attributes?.address
  // poolAddr is UNTRUSTED upstream data that we interpolate into the next URL
  // path. Only proceed for a well-formed EVM address — this blocks a malformed /
  // hostile Gecko response (e.g. "../.." or a full URL) from redirecting the
  // second fetch. Non-EVM Gecko pools are not isAddress, so degrade gracefully.
  if (!poolAddr || !isAddress(poolAddr)) {
    return { chainId, token, network, pool: null, timeframe, aggregate, candles: [] }
  }

  // 2. Pull the pool's OHLCV.
  const ohlcvRes = await timedFetch(
    fetchImpl,
    `${GECKO_API}/networks/${network}/pools/${poolAddr}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`,
    { headers: { accept: 'application/json' } },
    GECKO_TIMEOUT_MS,
    'get_token_chart',
  )
  if (!ohlcvRes.ok) throw new Error(`get_token_chart: ohlcv fetch failed (${ohlcvRes.status})`)
  const ohlcvJson = (await ohlcvRes.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } }
  const list = ohlcvJson.data?.attributes?.ohlcv_list ?? []
  // Each row is [t, o, h, l, c, v]; drop any malformed short row defensively.
  const candles: Candle[] = list
    .filter((row) => Array.isArray(row) && row.length >= 6)
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
  return { chainId, token, network, pool: poolAddr, timeframe, aggregate, candles }
}

export interface ExpectedSurplusResult {
  chainId: number
  sellToken: Address
  buyToken: Address
  sellAmount: string
  /** Ophis orderbook buy amount (atoms) for this sell, or null if unquotable. */
  ophisBuyAmount: string | null
  /** Reference all-DEX aggregator output (atoms) + which aggregator, or null. */
  reference: { name: string; buyAmount: string } | null
  /** How much better Ophis quotes vs the reference, in bips (+ = Ophis better).
   *  null when either side is unavailable. */
  beatBps: number | null
  note: string
}

/**
 * "Beat the market": compares the Ophis orderbook's sell-quote against a public
 * all-DEX aggregator (KyberSwap) for the same sell. Positive `beatBps` means
 * Ophis returns more of the buy token than the reference. Read-only; this is the
 * agent-facing version of the trade widget's pre-trade surplus number.
 */
export async function expectedSurplus(
  p: { chainId: number; sellToken: Address; buyToken: Address; sellAmount: string; from: Address },
  fetchImpl: typeof fetch = fetch,
): Promise<ExpectedSurplusResult> {
  const chainId = assertChain(p.chainId)
  const sellToken = checksum(p.sellToken, 'sellToken')
  const buyToken = checksum(p.buyToken, 'buyToken')
  const from = checksum(p.from, 'from')
  assertAtoms(p.sellAmount, 'sellAmount')

  // The two quotes are independent — fetch them concurrently so the tool's wall
  // time is one upstream round-trip, not two. Each side degrades to null on
  // failure rather than throwing (a missing side just leaves beatBps null).
  const slug = KYBER_SLUG[chainId]
  const [ophisBuyAmount, reference] = await Promise.all([
    // Ophis side (sell-kind quote) — tolerate an unquotable route.
    (async (): Promise<string | null> => {
      try {
        const q = await getQuote({ chainId, sellToken, buyToken, kind: 'sell', amount: p.sellAmount, from }, fetchImpl)
        return extractQuoteAmounts(q)?.buyAmount ?? null
      } catch {
        return null
      }
    })(),
    // Reference side (KyberSwap all-DEX).
    (async (): Promise<{ name: string; buyAmount: string } | null> => {
      if (!slug) return null
      try {
        const url = `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?tokenIn=${sellToken}&tokenOut=${buyToken}&amountIn=${p.sellAmount}`
        // KyberSwap 403s the default fetch UA; send a browser-like one.
        const res = await timedFetch(
          fetchImpl,
          url,
          { headers: { 'User-Agent': 'Mozilla/5.0 ophis-mcp', accept: 'application/json' } },
          TIMEOUT_MS.orderbook,
          'expected_surplus',
        )
        if (!res.ok) return null
        const j = (await res.json()) as { data?: { routeSummary?: { amountOut?: string } } }
        const out = j.data?.routeSummary?.amountOut
        // Length-cap too (a uint256 is <=78 digits): an un-capped huge amountOut
        // from a manipulated/compromised reference would otherwise be able to steer
        // beatBps to a sentinel value.
        return typeof out === 'string' && /^[0-9]+$/.test(out) && out.length <= 80
          ? { name: 'kyberswap', buyAmount: out }
          : null
      } catch {
        return null
      }
    })(),
  ])

  // Pure-BigInt bps. NOT Number(BigInt(atoms)): that collapses uint256 atoms to
  // float64 (53-bit mantissa) and can zero or even sign-flip the result for two
  // close quotes on an 18-decimal token. Mirrors the FE hook's BigInt math; the
  // final Number() is of a small bps integer, which is exact.
  let beatBps: number | null = null
  if (ophisBuyAmount && reference) {
    const o = BigInt(ophisBuyAmount)
    const r = BigInt(reference.buyAmount)
    if (r > 0n) beatBps = Number(((o - r) * 10_000n) / r)
  }
  // Self-describing degraded states so an agent can tell "checked, no edge" from
  // "could not check" — they mean very different things to a caller deciding a route.
  const note =
    ophisBuyAmount && reference
      ? 'beatBps > 0 means Ophis quoted more output than the KyberSwap all-DEX reference for this sell.'
      : !slug
        ? 'No reference aggregator configured for this chain; beatBps unavailable (NOT "no edge").'
        : !ophisBuyAmount && !reference
          ? 'Neither Ophis nor the reference could be quoted; beatBps unavailable (NOT "no edge").'
          : !ophisBuyAmount
            ? 'Ophis could not quote this pair; beatBps unavailable (NOT "no edge").'
            : 'The reference aggregator could not be reached; beatBps unavailable (NOT "no edge").'
  return {
    chainId,
    sellToken,
    buyToken,
    sellAmount: p.sellAmount,
    ophisBuyAmount,
    reference,
    beatBps,
    note,
  }
}

// --- resolve_token: symbol -> canonical address from the curated CoW token list ---
//
// The CoW-curated multi-chain list is the swap UI's priority-1 source for every
// chain except Optimism (which uses the Optimism official list). We resolve ONLY
// against these CURATED lists, never permissionless aggregator lists, so a miss is
// FAIL-CLOSED: we return the genuinely-canonical token or nothing, never a
// plausible-but-wrong scam token. The URLs are static constants; the caller's
// chainId only selects which curated list to read, so no caller input ever reaches
// the fetch URL (no SSRF). Every field of every list entry is untrusted and validated.
const COW_TOKEN_LIST_URL = 'https://files.cow.fi/tokens/CowSwap.json'
const OPTIMISM_TOKEN_LIST_URL = 'https://static.optimism.io/optimism.tokenlist.json'
const TOKEN_LIST_TIMEOUT_MS = 10_000
const MAX_TOKEN_DECIMALS = 36
const TOKEN_LIST_CACHE_MS = 10 * 60 * 1000
const MAX_LIST_TOKENS = 200_000 // bound CPU/memory on a hostile oversized list response
// Native-coin sentinels are not tradeable ERC-20s; agents trade the wrapped token.
const NATIVE_SENTINELS = new Set<string>([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
])
// Per-chain non-tradeable placeholders the swap UI also filters (mirrors
// apps/frontend/libs/tokens/src/utils/excludedListTokens.ts). The OP-stack legacy
// OVM_ETH at 0xDead...0000 ships in Optimism's list with symbol "ETH" and shadows
// native ETH; it is a dead pre-Bedrock placeholder, so resolving "ETH" to it would
// route quotes/orders to a no-liquidity address. Scoped per chain (the same vanity
// address can be a real token elsewhere), exactly as the frontend scopes it.
const EXCLUDED_TOKENS_BY_CHAIN: Record<number, ReadonlySet<string>> = {
  10: new Set<string>(['0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000']),
}

interface RawListToken {
  chainId?: unknown
  address?: unknown
  symbol?: unknown
  decimals?: unknown
  name?: unknown
}
export interface ResolvedToken {
  address: Address
  symbol: string
  decimals: number
  name: string
  source: string
}
export interface ResolveTokenResult {
  chainId: number
  query: string
  found: boolean
  ambiguous: boolean
  canonical: ResolvedToken | null
  matches: ResolvedToken[]
  note: string
}

/** Curated token-list URLs to consult for a chain, in priority order (first wins). */
function tokenListUrlsForChain(chainId: number): string[] {
  // Optimism's swap-UI priority-1 is the Optimism official list; the CoW list is
  // also consulted (it carries cross-chain majors), at lower priority.
  if (chainId === 10) return [OPTIMISM_TOKEN_LIST_URL, COW_TOKEN_LIST_URL]
  return [COW_TOKEN_LIST_URL]
}

// Per-isolate read cache of fetched lists. Only used for the real production fetch
// (a mock fetchImpl, i.e. tests, bypasses it so test runs stay isolated).
const tokenListCache = new Map<string, { at: number; tokens: unknown[] }>()

async function loadCuratedTokenList(url: string, fetchImpl: typeof fetch): Promise<unknown[]> {
  const useCache = fetchImpl === fetch
  const now = Date.now()
  if (useCache) {
    const hit = tokenListCache.get(url)
    if (hit && now - hit.at < TOKEN_LIST_CACHE_MS) return hit.tokens
  }
  const res = await timedFetch(fetchImpl, url, { headers: { accept: 'application/json' } }, TOKEN_LIST_TIMEOUT_MS, 'resolve_token')
  if (!res.ok) throw new Error(`resolve_token: token list returned ${res.status}`)
  const json = (await res.json()) as { tokens?: unknown }
  // A trusted source that does not return a proper, sanely-sized tokens array is
  // treated as UNAVAILABLE (throw), not an empty list. Returning [] would let a
  // malformed priority-1 source look "loaded" so a lower-priority list wins (a
  // partial view), and caching an oversized array would fail every retry for the
  // whole TTL. Only a well-formed, bounded list is cached and returned.
  if (!Array.isArray(json.tokens)) throw new Error('resolve_token: token list missing tokens array')
  if (json.tokens.length > MAX_LIST_TOKENS) throw new Error('resolve_token: token list oversized')
  const tokens = json.tokens
  if (useCache) tokenListCache.set(url, { at: now, tokens })
  return tokens
}

export async function resolveToken(
  p: { chainId: number; symbol: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveTokenResult> {
  const chainId = assertChain(p.chainId)
  const want = String(p.symbol).trim().toLowerCase()
  if (!want) throw new Error('resolve_token: symbol must be a non-empty string')

  const seen = new Set<string>()
  const matches: ResolvedToken[] = []
  let allSourcesLoaded = true
  for (const url of tokenListUrlsForChain(chainId)) {
    let tokens: unknown[]
    try {
      tokens = await loadCuratedTokenList(url, fetchImpl)
    } catch {
      // A trusted source was unavailable. We must NOT resolve from a PARTIAL view of
      // the trusted sources: that could mask the higher-priority list or a same-symbol
      // ambiguity it holds, weakening fail-closed. Record it and fail closed below.
      allSourcesLoaded = false
      continue
    }
    for (const raw of tokens) {
      if (!raw || typeof raw !== 'object') continue // skip null / primitive entries
      const t = raw as RawListToken
      // Every field is untrusted list data: validate types, never assume.
      if (t.chainId !== chainId) continue
      if (typeof t.symbol !== 'string' || t.symbol.toLowerCase() !== want) continue
      if (typeof t.address !== 'string' || !isAddress(t.address)) continue
      const address = getAddress(t.address) // EIP-55 checksum
      const key = address.toLowerCase()
      if (NATIVE_SENTINELS.has(key)) continue // native is not a tradeable ERC-20
      if (EXCLUDED_TOKENS_BY_CHAIN[chainId]?.has(key)) continue // non-tradeable placeholder the swap UI also filters (e.g. OP-stack legacy OVM_ETH that shadows native ETH)
      if (seen.has(key)) continue // first writer wins across the priority-ordered lists
      if (typeof t.decimals !== 'number' || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > MAX_TOKEN_DECIMALS) continue
      seen.add(key)
      matches.push({
        address,
        symbol: t.symbol,
        decimals: t.decimals,
        name: typeof t.name === 'string' ? t.name.slice(0, 80) : t.symbol,
        source: url,
      })
    }
  }

  // Fail closed if any trusted source could not be consulted: never resolve on a
  // partial view (it could hide the priority-1 answer or a same-symbol ambiguity).
  if (!allSourcesLoaded) {
    return {
      chainId,
      query: String(p.symbol),
      found: false,
      ambiguous: false,
      canonical: null,
      matches: [],
      note: 'A trusted token source was temporarily unavailable, so resolution is incomplete. Do not trade on a partial result: retry, or confirm the address with get_balances (symbol and decimals) and the user.',
    }
  }

  const found = matches.length > 0
  const ambiguous = matches.length > 1
  const note = !found
    ? 'No canonical match in the trusted Ophis/CoW token list. Do not guess or accept an address from chat, the web, or memory: confirm any candidate with get_balances (symbol and decimals) and with the user before trading.'
    : ambiguous
      ? 'Multiple trusted tokens share this symbol (for example a native and a bridged version), so no single canonical address is returned. Pick the intended one from `matches` and confirm with the user before trading.'
      : 'Resolved from the trusted Ophis/CoW token list.'
  // Fail closed on ambiguity: when several trusted tokens share the symbol, return NO
  // canonical (the priority-ordered `matches` are still provided) so a caller cannot grab
  // matches[0] and trade the wrong same-symbol variant (e.g. native vs bridged) without an
  // explicit choice. A single match still resolves to a canonical.
  return { chainId, query: String(p.symbol), found, ambiguous, canonical: ambiguous ? null : (matches[0] ?? null), matches, note }
}
