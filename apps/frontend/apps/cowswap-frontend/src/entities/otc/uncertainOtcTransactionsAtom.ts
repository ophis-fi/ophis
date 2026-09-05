import { atomWithStorage } from 'jotai/utils'

import { getJotaiIsolatedStorage, withStorageGuard } from '@cowprotocol/core'

import type { Hex } from 'viem'

const STORAGE_KEY = 'ophisOtcUncertainTransactions:v0'

export interface UncertainOtcTransaction {
  transactionHash: Hex
  recordedAt: number
}

export type UncertainOtcTransactions = Record<string, UncertainOtcTransaction>

function isUncertainOtcTransactions(value: unknown): value is UncertainOtcTransactions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.every(([, transaction]) => {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false
    const candidate = transaction as Record<string, unknown>
    return (
      typeof candidate.transactionHash === 'string' &&
      /^0x[0-9a-fA-F]{64}$/.test(candidate.transactionHash) &&
      typeof candidate.recordedAt === 'number' &&
      Number.isFinite(candidate.recordedAt) &&
      candidate.recordedAt >= 0
    )
  })
}

const guardedStorage = withStorageGuard<UncertainOtcTransactions>(
  getJotaiIsolatedStorage<UncertainOtcTransactions>(),
  isUncertainOtcTransactions,
  STORAGE_KEY,
)

export const uncertainOtcTransactionsAtom = atomWithStorage<UncertainOtcTransactions>(STORAGE_KEY, {}, guardedStorage, {
  getOnInit: true,
})

export function recordUncertainOtcTransaction(
  transactions: UncertainOtcTransactions,
  key: string,
  transactionHash: Hex,
  recordedAt = Date.now(),
): UncertainOtcTransactions {
  return { ...transactions, [key]: { transactionHash, recordedAt } }
}

export function removeUncertainOtcTransaction(
  transactions: UncertainOtcTransactions,
  key: string,
  expectedHash?: Hex,
): UncertainOtcTransactions {
  if (!(key in transactions)) return transactions
  if (expectedHash && transactions[key].transactionHash !== expectedHash) return transactions
  const next = { ...transactions }
  delete next[key]
  return next
}
