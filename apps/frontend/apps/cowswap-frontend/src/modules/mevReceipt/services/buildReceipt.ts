import type { BuildReceiptInput, MevProofReceipt, PartnerFeeInfo } from '../types'

const extractPartnerFee = (fullAppData: string | null): PartnerFeeInfo | null => {
  if (!fullAppData) return null
  try {
    const parsed = JSON.parse(fullAppData)
    const pf = parsed?.metadata?.partnerFee
    if (!pf || typeof pf.recipient !== 'string') return null
    // Ophis-scoped decode: only the two fee models Ophis can produce are
    // recognised. CIP-75's surplus and tiered-array models never appear in
    // Ophis appData, so any other shape falls through to null rather than
    // being guessed at — this receipt is not a generic CoW partner-fee parser.
    //
    // CIP-75 price-improvement model — what Ophis writes on the chains it
    // operates. Checked before the volume branch: a PI appData carries no
    // volumeBps, so the pre-fix `volumeBps ?? bps` path returned null and the
    // receipt under-reported a real 25%-of-improvement fee as "(none)".
    if (typeof pf.priceImprovementBps === 'number' && typeof pf.maxVolumeBps === 'number') {
      return {
        type: 'priceImprovement',
        priceImprovementBps: pf.priceImprovementBps,
        maxVolumeBps: pf.maxVolumeBps,
        recipient: pf.recipient,
      }
    }
    // Legacy flat-volume model (widget overrides, older appData).
    const volumeBps = pf.volumeBps ?? pf.bps
    if (typeof volumeBps !== 'number') return null
    return { type: 'volume', volumeBps, recipient: pf.recipient }
  } catch {
    return null
  }
}

const calcSurplus = (executedBuy: string, quotedBuy: string): number | null => {
  if (!executedBuy || executedBuy === '0' || !quotedBuy || quotedBuy === '0') return null
  const exec = BigInt(executedBuy)
  const quoted = BigInt(quotedBuy)
  if (quoted === 0n) return null
  const num = Number(exec - quoted)
  const denom = Number(quoted)
  return num / denom
}

export const buildReceipt = ({ order, trade, chainId }: BuildReceiptInput): MevProofReceipt => ({
  orderUid: order.uid,
  chainId,
  owner: order.owner,
  sellToken: order.sellToken,
  buyToken: order.buyToken,
  sellAmount: order.sellAmount,
  buyAmount: order.buyAmount,
  executedSellAmount: order.executedSellAmount,
  executedBuyAmount: order.executedBuyAmount,
  validTo: order.validTo,
  settlementTxHash: trade?.txHash ?? null,
  settlementBlock: trade?.blockNumber ?? null,
  status: order.status,
  partnerFee: extractPartnerFee(order.fullAppData),
  surplusVsQuote: trade ? calcSurplus(order.executedBuyAmount, order.buyAmount) : null,
  receiptVersion: '2',
  generatedAt: new Date().toISOString(),
})
