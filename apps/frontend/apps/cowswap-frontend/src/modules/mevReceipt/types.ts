/**
 * MEV-proof receipt for a CoW Protocol settled order, designed for
 * accounting / audit / treasury reporting use. Contains everything a
 * recipient needs to verify the order was settled at a fair price with
 * MEV protection.
 *
 * Derived from `api.cow.fi`'s order + trades endpoints.
 */

export interface PartnerFeeInfo {
  readonly volumeBps: number
  readonly recipient: string
}

export interface MevProofReceipt {
  /** CoW order UID (66-char hex including the 0x prefix). */
  readonly orderUid: string
  /** EVM chainId — 1, 100, 8453, etc. */
  readonly chainId: number
  /** EOA / Safe that signed the order. */
  readonly owner: string
  /** ERC-20 sold. */
  readonly sellToken: string
  /** ERC-20 bought. */
  readonly buyToken: string
  /** Original sellAmount as signed (post-CoW-fee). */
  readonly sellAmount: string
  /** Original buyAmount floor as signed. */
  readonly buyAmount: string
  /** Final executed sellAmount (== sellAmount for fully-fulfilled non-partial orders). */
  readonly executedSellAmount: string
  /** Final executed buyAmount; "0" if order is open or expired. */
  readonly executedBuyAmount: string
  /** Order validTo timestamp (Unix seconds). */
  readonly validTo: number
  /** On-chain settlement tx hash; null if not yet settled. */
  readonly settlementTxHash: string | null
  /** Block number of settlement; null if not yet settled. */
  readonly settlementBlock: number | null
  /** Order status from CoW API (fulfilled / open / cancelled / expired). */
  readonly status: string
  /** Partner-fee config baked into the order's appData; null if order had no partner fee. */
  readonly partnerFee: PartnerFeeInfo | null
  /** Fractional surplus over the quoted minimum buyAmount; null if not settled. (executed - quoted) / quoted */
  readonly surplusVsQuote: number | null
  /** Greg's receipt schema version. */
  readonly receiptVersion: '1'
  /** ISO-8601 UTC timestamp of receipt creation. */
  readonly generatedAt: string
}

export interface BuildReceiptInput {
  readonly order: {
    readonly uid: string
    readonly owner: string
    readonly status: string
    readonly sellToken: string
    readonly buyToken: string
    readonly sellAmount: string
    readonly buyAmount: string
    readonly executedSellAmount: string
    readonly executedBuyAmount: string
    readonly validTo: number
    readonly fullAppData: string | null
  }
  readonly trade: {
    readonly blockNumber: number
    readonly txHash: string
    readonly buyAmount: string
    readonly sellAmount: string
  } | null
  readonly chainId: number
}
