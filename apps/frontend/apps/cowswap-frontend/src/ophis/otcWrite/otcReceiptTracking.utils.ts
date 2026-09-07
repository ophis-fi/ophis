import { verifyOtcTransactionProof } from './otcTransactionProof'

import type { OtcTransactionReceipt } from './otcWrite.types'
import type { OtcSubmissionProof } from 'entities/otc'
import type { Hex, PublicClient } from 'viem'

export const OTC_RECEIPT_TIMEOUT_MS = 120_000

export function assertOtcReceipt(hash: Hex, receipt: OtcTransactionReceipt): void {
  if ((receipt.replacedTransactionHash ?? receipt.transactionHash).toLowerCase() !== hash.toLowerCase()) {
    throw new Error('Ophis OTC transaction was replaced')
  }
  if (receipt.status !== 'success' && receipt.status !== 'reverted') {
    throw new Error('Ophis OTC transaction confirmation unavailable')
  }
}

export async function waitForOtcReceipt(
  publicClient: PublicClient,
  hash: Hex,
  proof?: OtcSubmissionProof,
): Promise<OtcTransactionReceipt> {
  let confirmedHash = hash.toLowerCase() as Hex
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: OTC_RECEIPT_TIMEOUT_MS,
    onReplaced: ({ reason, replacedTransaction, transaction }) => {
      if (reason === 'repriced' && replacedTransaction.hash.toLowerCase() === confirmedHash) {
        confirmedHash = transaction.hash.toLowerCase() as Hex
      }
    },
  })
  if (receipt.transactionHash.toLowerCase() !== confirmedHash) throw new Error('Ophis OTC transaction was replaced')
  if (proof) await verifyOtcTransactionProof(publicClient, receipt.transactionHash, proof)
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    ...(confirmedHash !== hash.toLowerCase() ? { replacedTransactionHash: hash } : {}),
  }
}
