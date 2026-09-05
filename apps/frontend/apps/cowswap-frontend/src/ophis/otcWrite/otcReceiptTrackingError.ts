import type { Hex } from 'viem'

export class OtcReceiptTrackingError extends Error {
  constructor(
    readonly transactionHash: Hex,
    readonly receiptError: unknown,
  ) {
    super('Ophis OTC transaction submitted; receipt status is unknown')
    this.name = 'OtcReceiptTrackingError'
  }
}
