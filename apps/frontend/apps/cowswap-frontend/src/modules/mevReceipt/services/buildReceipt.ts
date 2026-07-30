import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import type { BuildReceiptInput, MevProofReceipt, PartnerFeeInfo } from '../types'

const isOphisRecipient = (entry: unknown): boolean =>
  !!entry &&
  typeof entry === 'object' &&
  typeof (entry as { recipient?: unknown }).recipient === 'string' &&
  (entry as { recipient: string }).recipient.toLowerCase() === OPHIS_PARTNER_FEE_RECIPIENT.toLowerCase()

const extractPartnerFee = (fullAppData: string | null): PartnerFeeInfo | null => {
  if (!fullAppData) return null
  try {
    const parsed = JSON.parse(fullAppData)
    const raw = parsed?.metadata?.partnerFee
    // metadata.partnerFee is a single object (SDK/front-end orders) OR an array
    // (a compat order that mapped an Odos referralFee stacks the integrator entry
    // beside the Ophis default). For the array, pick the Ophis-recipient entry:
    // this receipt reports the Ophis protocol fee, not a third party's fee. A
    // single object is used as-is, whatever its recipient (unchanged behavior).
    const pf = Array.isArray(raw) ? (raw.find(isOphisRecipient) ?? null) : raw
    if (!pf || typeof pf.recipient !== 'string') return null
    // Ophis-scoped decode: only the two fee models Ophis can produce are
    // recognised. CIP-75's surplus and tiered-array models never appear in
    // Ophis appData, so any other shape falls through to null rather than
    // being guessed at — this receipt is not a generic CoW partner-fee parser.
    //
    // CIP-75 price-improvement model — the legacy Ophis shape (flag-off
    // fallback + historical orders settled before the 2026-06-08 flat-fee
    // flip). Checked before the volume branch: a PI appData carries no
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
    // Flat-volume model — what Ophis writes in production since the
    // 2026-06-08 flag flip (also: widget overrides, `bps` legacy alias).
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

export const buildReceipt = ({ order, trade, chainId, pathVizSvgBase64 }: BuildReceiptInput): MevProofReceipt => ({
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
  pathVizSvgBase64: pathVizSvgBase64 ?? null,
  receiptVersion: '3',
  generatedAt: new Date().toISOString(),
})
