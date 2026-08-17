import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import type { BuildReceiptInput, MevProofReceipt, PartnerFeeInfo } from '../types'

const isOphisRecipient = (entry: unknown): boolean =>
  !!entry &&
  typeof entry === 'object' &&
  typeof (entry as { recipient?: unknown }).recipient === 'string' &&
  (entry as { recipient: string }).recipient.toLowerCase() === OPHIS_PARTNER_FEE_RECIPIENT.toLowerCase()

type PartnerFeeRecord = Record<string, unknown> & { recipient: string }

function selectPartnerFee(raw: unknown): unknown {
  return Array.isArray(raw) ? raw.find(isOphisRecipient) : raw
}

function asPartnerFeeRecord(value: unknown): PartnerFeeRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return typeof record.recipient === 'string' ? (record as PartnerFeeRecord) : null
}

function decodePartnerFee(record: PartnerFeeRecord): PartnerFeeInfo | null {
  if (typeof record.priceImprovementBps === 'number' && typeof record.maxVolumeBps === 'number') {
    return {
      type: 'priceImprovement',
      priceImprovementBps: record.priceImprovementBps,
      maxVolumeBps: record.maxVolumeBps,
      recipient: record.recipient,
    }
  }
  const volumeBps = record.volumeBps ?? record.bps
  return typeof volumeBps === 'number' ? { type: 'volume', volumeBps, recipient: record.recipient } : null
}

const extractPartnerFee = (fullAppData: string | null): PartnerFeeInfo | null => {
  if (!fullAppData) return null
  try {
    const parsed = JSON.parse(fullAppData) as { metadata?: { partnerFee?: unknown } }
    const partnerFee = asPartnerFeeRecord(selectPartnerFee(parsed.metadata?.partnerFee))
    // metadata.partnerFee is a single object (SDK/front-end orders) OR an array
    // (a compat order that mapped an Odos referralFee stacks the integrator entry
    // beside the Ophis default). For the array, pick the Ophis-recipient entry:
    // this receipt reports the Ophis protocol fee, not a third party's fee. A
    // single object is used as-is, whatever its recipient (unchanged behavior).
    if (!partnerFee) return null
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
    return decodePartnerFee(partnerFee)
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

function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null
}

function surplusForTrade(trade: BuildReceiptInput['trade'], executedBuy: string, quotedBuy: string): number | null {
  return trade ? calcSurplus(executedBuy, quotedBuy) : null
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
  settlementTxHash: nullable(trade?.txHash),
  settlementBlock: nullable(trade?.blockNumber),
  status: order.status,
  partnerFee: extractPartnerFee(order.fullAppData),
  surplusVsQuote: surplusForTrade(trade, order.executedBuyAmount, order.buyAmount),
  pathVizSvgBase64: nullable(pathVizSvgBase64),
  receiptVersion: '3',
  generatedAt: new Date().toISOString(),
})
