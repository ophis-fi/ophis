import { atom } from 'jotai'
import { atomWithStorage, createJSONStorage } from 'jotai/utils'

import { withStorageGuard } from '@cowprotocol/core'

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

const sharedStorage = createJSONStorage<UncertainOtcTransactions>(() => localStorage)
const guardedStorage = withStorageGuard<UncertainOtcTransactions>(
  sharedStorage,
  isUncertainOtcTransactions,
  STORAGE_KEY,
)
guardedStorage.subscribe = (key, callback, initial) =>
  sharedStorage.subscribe?.(key, () => callback(guardedStorage.getItem(key, initial)), initial) ?? (() => undefined)

export const uncertainOtcTransactionsAtom = atomWithStorage<UncertainOtcTransactions>(STORAGE_KEY, {}, guardedStorage, {
  getOnInit: true,
})

export const coordinatedOtcTransactionAtom = atom(
  null,
  async (_get, set, operation: (transactions: UncertainOtcTransactions) => Promise<void>): Promise<void> => {
    if (!navigator.locks) throw new Error('Ophis OTC browser transaction coordination unavailable')
    // ponytail: serialize all fork OTC actions per origin; use per-intent locks if concurrent desk throughput matters.
    await navigator.locks.request(STORAGE_KEY, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('Ophis OTC transaction is already active in another tab')
      const transactions = guardedStorage.getItem(STORAGE_KEY, {})
      set(uncertainOtcTransactionsAtom, transactions)
      await operation(transactions)
    })
  },
)

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
