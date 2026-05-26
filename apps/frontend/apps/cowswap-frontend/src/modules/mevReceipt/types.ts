/**
 * MEV-proof receipt for a CoW Protocol settled order, designed for
 * accounting / audit / treasury reporting use. Contains everything a
 * recipient needs to verify the order was settled at a fair price with
 * MEV protection.
 *
 * Derived from `api.cow.fi`'s order + trades endpoints.
 */

/**
 * Partner-fee config baked into the order's appData. CIP-75 lets a partner
 * pick a monetisation model; Ophis writes the `priceImprovement` shape on the
 * chains it operates, while widget consumers may override with the legacy flat
 * `volume` shape. Discriminated on `type` so a receipt records exactly which
 * model — and which bps — applied, rather than collapsing distinct fee
 * structures into one ambiguous number. CIP-75's surplus and tiered-array
 * models are out of scope: Ophis never emits them, so they decode to null.
 */
export type PartnerFeeInfo =
  | {
      readonly type: 'priceImprovement'
      /** Share of execution beating the shown quote, in bps (Ophis: 2500 = 25%). */
      readonly priceImprovementBps: number
      /** Hard ceiling on the fee as a fraction of volume, in bps (Ophis: 50 = 0.5%). */
      readonly maxVolumeBps: number
      readonly recipient: string
    }
  | {
      readonly type: 'volume'
      /** Flat fee as a fraction of trade volume, in bps. */
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
  /** Partner-fee config baked into the order's appData; null if the order had no partner fee. */
  readonly partnerFee: PartnerFeeInfo | null
  /** Fractional surplus over the quoted minimum buyAmount; null if not settled. (executed - quoted) / quoted */
  readonly surplusVsQuote: number | null
  /** Ophis's receipt schema version. Bumped to '2' when partnerFee became a
   * discriminated union (priceImprovement | volume); v1 only carried volumeBps. */
  readonly receiptVersion: '2'
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
