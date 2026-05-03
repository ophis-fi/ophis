import type { BuildReceiptInput, MevProofReceipt, PartnerFeeInfo } from '../types'

const extractPartnerFee = (fullAppData: string | null): PartnerFeeInfo | null => {
  if (!fullAppData) return null
  try {
    const parsed = JSON.parse(fullAppData)
    const pf = parsed?.metadata?.partnerFee
    if (!pf || typeof pf.recipient !== 'string') return null
    const volumeBps = pf.volumeBps ?? pf.bps
    if (typeof volumeBps !== 'number') return null
    return { volumeBps, recipient: pf.recipient }
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
  receiptVersion: '1',
  generatedAt: new Date().toISOString(),
})
