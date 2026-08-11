import { OPHIS_PARTNER_FEE_RECIPIENT } from '@cowprotocol/common-const'
import { NearIntentsBridgeProvider } from '@cowprotocol/sdk-bridging'

import { utils } from 'ethers'

/**
 * Ophis NEAR Intents provider. Two jobs:
 *
 * 1. FIX QUOTING: sdk-bridging 4.0.2 hashes `depositMode` into the attested
 *    quote hash, but the 1-Click server dropped that field from ITS hash
 *    (upstream hit the same break and fixed it in sdk 4.2.2 — merge
 *    3146730583, "fix near bridging #7716"). Result: every NEAR quote on the
 *    pinned SDK fails recoverDepositAddress and throws
 *    QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS. The override below rebuilds the
 *    hash without `depositMode` — verified live against /v0/attestation
 *    (2026-08-11): the recovered signer matches the attestor again.
 *    ⚠️ This struct tracks NEAR's server-side hash. If NEAR quoting ever dies
 *    app-wide with QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS, suspect another
 *    server-side field change FIRST (it has happened twice now).
 *
 * 2. MONETIZE + ATTRIBUTE: injects `referral: "ophis"` (the stock SDK
 *    hardcodes "cow") and a 3 bps `appFees` entry paid to the partner-fee
 *    Safe. 1-Click accepts an EVM recipient directly, and the server excludes
 *    appFees from the attested hash (both verified live 2026-08-11), so the
 *    fee cannot break attestation. Fee parity with the Bungee proxy
 *    (functions/api/bungee BUNGEE_INTEGRATOR_FEE_BPS) keeps the best-quote
 *    comparison between providers honest.
 */

const OPHIS_NEAR_REFERRAL = 'ophis'

// 3 bps of amountIn, taken by NEAR's settlement and paid to the Safe. In
// keyless (local dev) mode the platform's own unauthenticated appFee is
// additionally present server-side; with the production API key ours is the
// only one.
const OPHIS_NEAR_APP_FEES = [{ recipient: OPHIS_PARTNER_FEE_RECIPIENT, fee: 3 }]

// Attestation constants (not exported by sdk-bridging; mirrored from its
// dist and verified live: the recovered signer equals ATTESTATOR_ADDRESS).
const ATTESTATION_PREFIX = '0x0a773570'
const ATTESTATION_VERSION_BYTE = '0x00'
export const NEAR_INTENTS_ATTESTATOR_ADDRESS = '0x0073DD100b51C555E41B2a452E5933ef76F42790'

type NearQuoteResponse = Parameters<NearIntentsBridgeProvider['recoverDepositAddress']>[0]

/**
 * Sorted-key JSON serialization, byte-identical to json-stable-stringify for
 * the FLAT struct below (string/number/boolean values, undefined dropped —
 * no nesting, so no recursive sorting is needed and the dependency isn't
 * either). Cross-validated against the real json-stable-stringify via the
 * golden hash in the test file.
 */
export function stableStringifyFlat(obj: Record<string, unknown>): string {
  const sorted = Object.entries(obj)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return JSON.stringify(Object.fromEntries(sorted))
}

/**
 * The exact object the 1-Click server hashes for deposit-address attestation
 * (sha256 over json-stable-stringify of this). Mirrors sdk-bridging >=4.2.2:
 * NO `depositMode`, NO `appFees` — both deliberately absent from the server's
 * hash. Key order does not matter (stable stringify sorts).
 */
export function buildNearQuoteHashInput(
  quote: NearQuoteResponse['quote'],
  quoteRequest: NearQuoteResponse['quoteRequest'],
  timestamp: NearQuoteResponse['timestamp'],
): Record<string, unknown> {
  return {
    dry: false,
    swapType: quoteRequest.swapType,
    slippageTolerance: quoteRequest.slippageTolerance,
    originAsset: quoteRequest.originAsset,
    depositType: quoteRequest.depositType,
    destinationAsset: quoteRequest.destinationAsset,
    amount: quoteRequest.amount,
    refundTo: quoteRequest.refundTo,
    refundType: quoteRequest.refundType,
    recipient: quoteRequest.recipient,
    recipientType: quoteRequest.recipientType,
    deadline: quoteRequest.deadline,
    quoteWaitingTimeMs: quoteRequest.quoteWaitingTimeMs ? quoteRequest.quoteWaitingTimeMs : undefined,
    referral: quoteRequest.referral ? quoteRequest.referral : undefined,
    virtualChainRecipient: quoteRequest.virtualChainRecipient ? quoteRequest.virtualChainRecipient : undefined,
    virtualChainRefundRecipient: quoteRequest.virtualChainRefundRecipient
      ? quoteRequest.virtualChainRefundRecipient
      : undefined,
    customRecipientMsg: undefined,
    sessionId: undefined,
    connectedWallets: undefined,
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted,
    amountInUsd: quote.amountInUsd,
    minAmountIn: quote.minAmountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut,
    timestamp,
  }
}

/**
 * Pure request augmentation, split out for testability: adds Ophis referral
 * attribution and the integrator appFees to a 1-Click quote request.
 */
export function withOphisNearQuoteParams<T extends object>(request: T): T {
  // referral/appFees exist on the server API but not yet on the pinned
  // one-click client types — the cast tracks the server contract.
  return { ...request, referral: OPHIS_NEAR_REFERRAL, appFees: OPHIS_NEAR_APP_FEES } as T
}

export class OphisNearIntentsBridgeProvider extends NearIntentsBridgeProvider {
  constructor(options?: ConstructorParameters<typeof NearIntentsBridgeProvider>[0]) {
    super(options)

    const originalGetQuote = this.api.getQuote.bind(this.api)
    this.api.getQuote = (request) => originalGetQuote(withOphisNearQuoteParams(request))
  }

  async recoverDepositAddress(
    quoteResponse: NearQuoteResponse,
  ): ReturnType<NearIntentsBridgeProvider['recoverDepositAddress']> {
    try {
      const { quote, quoteRequest, timestamp } = quoteResponse
      if (!quote?.depositAddress) return null

      const stringifiedQuote = stableStringifyFlat(buildNearQuoteHashInput(quote, quoteRequest, timestamp))

      const quoteHash = utils.sha256(utils.toUtf8Bytes(stringifiedQuote)) as `0x${string}`
      const depositAddress = utils.getAddress(quote.depositAddress)

      const { signature } = await this.api.getAttestation({ quoteHash, depositAddress })
      if (!signature || !utils.isHexString(signature)) return null

      const message = utils.hexConcat([ATTESTATION_PREFIX, ATTESTATION_VERSION_BYTE, depositAddress, quoteHash])

      return {
        address: utils.recoverAddress(utils.keccak256(message), signature),
        quoteHash,
        stringifiedQuote,
        // Safe: isHexString guarded above
        attestationSignature: signature as `0x${string}`,
      }
    } catch {
      return null
    }
  }
}
