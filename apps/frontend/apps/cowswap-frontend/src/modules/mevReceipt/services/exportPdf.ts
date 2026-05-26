import { jsPDF } from 'jspdf'

import type { MevProofReceipt, PartnerFeeInfo } from '../types'

const formatPartnerFee = (fee: PartnerFeeInfo | null): string => {
  if (!fee) return '(none)'
  if (fee.type === 'priceImprovement') {
    return `${fee.priceImprovementBps} bps of price improvement (max ${fee.maxVolumeBps} bps of volume) -> ${fee.recipient}`
  }
  return `${fee.volumeBps} bps of volume -> ${fee.recipient}`
}

/**
 * Generates a single-page PDF of a CoW Protocol order receipt.
 * Plain monospace layout — the goal is auditable evidence, not visual flair.
 * Compatible with treasury-team accounting workflows.
 */
export const exportPdf = (receipt: MevProofReceipt): Blob => {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })

  doc.setFontSize(14)
  doc.text('Ophis — MEV-Proof Order Receipt', 40, 50)

  doc.setFontSize(10)
  doc.setFont('courier', 'normal')

  const lines: string[] = [
    `Order UID:        ${receipt.orderUid}`,
    `Chain ID:         ${receipt.chainId}`,
    `Owner:            ${receipt.owner}`,
    `Status:           ${receipt.status}`,
    '',
    `Sell token:       ${receipt.sellToken}`,
    `Buy token:        ${receipt.buyToken}`,
    `Sell amount:      ${receipt.sellAmount}`,
    `Buy amount min:   ${receipt.buyAmount}`,
    `Executed sell:    ${receipt.executedSellAmount}`,
    `Executed buy:     ${receipt.executedBuyAmount}`,
    '',
    `Settlement tx:    ${receipt.settlementTxHash ?? '(not settled)'}`,
    `Block:            ${receipt.settlementBlock ?? '-'}`,
    `Surplus vs quote: ${receipt.surplusVsQuote === null ? '-' : `${(receipt.surplusVsQuote * 100).toFixed(2)}%`}`,
    '',
    `Partner fee:      ${formatPartnerFee(receipt.partnerFee)}`,
    '',
    `Receipt version:  ${receipt.receiptVersion}`,
    `Generated:        ${receipt.generatedAt}`,
  ]

  let y = 80
  for (const line of lines) {
    doc.text(line, 40, y)
    y += 14
  }

  return doc.output('blob')
}
