import type { OtcTransactionReceipt } from './otcWrite.types'
import type { Hex, PublicClient } from 'viem'

export const OTC_RECEIPT_TIMEOUT_MS = 120_000

export async function waitForOtcReceipt(publicClient: PublicClient, hash: Hex): Promise<OtcTransactionReceipt> {
  let confirmedHash = hash
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: OTC_RECEIPT_TIMEOUT_MS,
    onReplaced: ({ reason, replacedTransaction, transaction }) => {
      if (reason === 'repriced' && replacedTransaction.hash === confirmedHash) confirmedHash = transaction.hash
    },
  })
  if (receipt.transactionHash !== confirmedHash) throw new Error('Ophis OTC transaction was replaced')
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    ...(confirmedHash !== hash ? { replacedTransactionHash: hash } : {}),
  }
}
