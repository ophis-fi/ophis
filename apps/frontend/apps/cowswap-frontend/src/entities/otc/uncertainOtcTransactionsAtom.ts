import { atom } from 'jotai'
import { atomWithStorage, createJSONStorage } from 'jotai/utils'

import { withStorageGuard } from '@cowprotocol/core'

import type { Hex } from 'viem'

const LEGACY_STORAGE_KEY = 'ophisOtcUncertainTransactions:v0'
const STORAGE_KEY = 'ophisOtcUncertainTransactions:v1'

export interface OtcSubmissionProof {
  requestHash: Hex
  nonce: number
}

export interface UncertainOtcTransaction {
  attemptId?: string
  proof?: OtcSubmissionProof
  transactionHash: Hex | null
  recordedAt: number
}

export type UncertainOtcTransactions = Record<string, UncertainOtcTransaction>

function isUncertainOtcTransactions(value: unknown): value is UncertainOtcTransactions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.every(([, transaction]) => {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false
    const candidate = transaction as Record<string, unknown>
    if (!hasValidRecoveryMetadata(candidate)) return false
    return (
      (candidate.transactionHash === null || isTransactionHash(candidate.transactionHash)) &&
      typeof candidate.recordedAt === 'number' &&
      Number.isFinite(candidate.recordedAt) &&
      candidate.recordedAt >= 0
    )
  })
}

function hasValidRecoveryMetadata(candidate: Record<string, unknown>): boolean {
  return (
    (candidate.attemptId === undefined ||
      (typeof candidate.attemptId === 'string' && /^\d{1,10}(?:-\d{1,10}){3}$/.test(candidate.attemptId))) &&
    (candidate.proof === undefined || isSubmissionProof(candidate.proof))
  )
}

function isTransactionHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function isSubmissionProof(value: unknown): value is OtcSubmissionProof {
  if (!value || typeof value !== 'object') return false
  const proof = value as Record<string, unknown>
  return (
    isTransactionHash(proof.requestHash) &&
    typeof proof.nonce === 'number' &&
    Number.isSafeInteger(proof.nonce) &&
    proof.nonce >= 0
  )
}

const sharedStorage = createJSONStorage<UncertainOtcTransactions>(() => localStorage)
const guardedStorage = withStorageGuard<UncertainOtcTransactions>(
  sharedStorage,
  isUncertainOtcTransactions,
  STORAGE_KEY,
)
// Fall back to known legacy hashes only until v1 is first written. A persisted empty v1 map
// is authoritative, so cleared legacy locks never reappear. Old bundles cannot overwrite v1.
const readCurrentStorage = guardedStorage.getItem
guardedStorage.getItem = (key, initial) => readCurrentStorage(key, readCurrentStorage(LEGACY_STORAGE_KEY, initial))
guardedStorage.subscribe = (key, callback, initial) =>
  sharedStorage.subscribe?.(key, () => callback(guardedStorage.getItem(key, initial)), initial) ?? (() => undefined)

export const uncertainOtcTransactionsAtom = atomWithStorage<UncertainOtcTransactions>(STORAGE_KEY, {}, guardedStorage, {
  getOnInit: true,
})

export const coordinatedOtcTransactionAtom = atom(
  null,
  async (_get, set, operation: (transactions: UncertainOtcTransactions) => Promise<void>): Promise<void> => {
    if (!navigator.locks) throw new Error('Ophis OTC browser transaction coordination unavailable')
    // ponytail: serialize all OTC actions per origin; use per-intent locks if concurrent desk throughput matters.
    // Keep the existing lock name to serialize with older fork-only tabs.
    await navigator.locks.request(LEGACY_STORAGE_KEY, { ifAvailable: true }, async (lock) => {
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
  transactionHash: Hex | null,
  recordedAt = Date.now(),
  proof?: OtcSubmissionProof,
): UncertainOtcTransactions {
  return {
    ...transactions,
    [key]: {
      attemptId: transactions[key]?.attemptId ?? crypto.getRandomValues(new Uint32Array(4)).join('-'),
      transactionHash,
      recordedAt,
      proof: proof ?? transactions[key]?.proof,
    },
  }
}

export function removeUncertainOtcTransaction(
  transactions: UncertainOtcTransactions,
  key: string,
  expectedHash?: Hex | null,
  expectedAttemptId?: string,
): UncertainOtcTransactions {
  if (!(key in transactions)) return transactions
  if (expectedAttemptId !== undefined && transactions[key].attemptId !== expectedAttemptId) return transactions
  if (expectedHash !== undefined && transactions[key].transactionHash !== expectedHash) return transactions
  const next = { ...transactions }
  delete next[key]
  return next
}
