import { atomWithStorage, createJSONStorage } from 'jotai/utils'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { BaseError, UserRejectedRequestError, type Hex, type WalletClient } from 'viem'
import { z } from 'zod'

import {
  ARC_SPOKE_POOL,
  acrossApi,
  acrossQuoteSchema,
  assertAcrossQuote,
  type AcrossQuote,
} from './acrossQuote.service'
import { arcClient, sendAcross } from './acrossWallet.service'

export const ACROSS_STORAGE_KEY = 'ophisArcAcross:v0'
const jsonStorage = createJSONStorage<unknown>()
export const acrossStorage: typeof jsonStorage = {
  ...jsonStorage,
  getItem: (key, initialValue) => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initialValue : JSON.parse(raw)
    } catch {
      return { invalidRecovery: true }
    }
  },
  subscribe: (key, callback, initialValue) =>
    jsonStorage.subscribe?.(key, () => callback(acrossStorage.getItem(key, initialValue)), initialValue) ??
    (() => undefined),
}
export const acrossPendingAtom = atomWithStorage<unknown>(ACROSS_STORAGE_KEY, null, acrossStorage, { getOnInit: true })
const txHash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value as Hex)
export const acrossPendingSchema = acrossQuoteSchema
  .extend({
    nonce: z.number().int().nonnegative().safe(),
    hash: txHash.optional(),
  })
  .refine((value) => {
    try {
      assertAcrossQuote(value, false)
      return true
    } catch {
      return false
    }
  })
export type AcrossPending = z.infer<typeof acrossPendingSchema>
type Persist = (value: AcrossPending | null) => void

async function withAcrossLock(action: () => Promise<void>): Promise<void> {
  if (!navigator.locks) throw new Error('Please use a current browser to bridge.')
  await navigator.locks.request(ACROSS_STORAGE_KEY, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is updating this bridge. Please wait.')
    await action()
  })
}

function explicitlyRejected(error: unknown): boolean {
  return error instanceof BaseError
    ? error.walk((cause) => cause instanceof UserRejectedRequestError) instanceof UserRejectedRequestError
    : typeof error === 'object' && error !== null && 'code' in error && error.code === 4001
}

export function acrossError(error: unknown): string {
  if (explicitlyRejected(error)) return 'Request declined in your wallet.'
  if (error instanceof BaseError) return error.shortMessage
  return error instanceof Error ? error.message : 'Across request failed. Check your wallet activity.'
}

export async function submitAcross(
  wallet: WalletClient,
  quote: AcrossQuote,
  persist: Persist,
  assertCurrent: () => void,
): Promise<void> {
  await withAcrossLock(async () => {
    if (await acrossStorage.getItem(ACROSS_STORAGE_KEY, null))
      throw new Error('An Across transfer may already be pending. Resume it before sending again.')
    const journal: { pending: AcrossPending | null } = { pending: null }
    let signatureRequested = false
    try {
      const hash = await sendAcross(
        wallet,
        quote,
        async (nonce) => {
          journal.pending = { ...quote, nonce }
          persist(journal.pending)
          if (JSON.stringify(await acrossStorage.getItem(ACROSS_STORAGE_KEY, null)) !== JSON.stringify(journal.pending))
            throw new Error('Could not save recovery details. Nothing was signed.')
          assertCurrent()
          assertAcrossQuote(quote)
          signatureRequested = true
        },
        assertCurrent,
      )
      txHash.parse(hash)
      if (!journal.pending) throw new Error('Missing bridge recovery details.')
      try {
        persist({ ...journal.pending, hash })
      } catch {
        throw new Error(`Save your bridge transaction hash: ${hash}`)
      }
    } catch (error) {
      if (!signatureRequested || explicitlyRejected(error)) persist(null)
      throw error
    }
  })
}

export async function acrossStatus(pending: AcrossPending): Promise<string> {
  if (!pending.hash) return 'Check wallet activity and add the transaction hash to resume tracking.'
  await verifyAcrossTransaction(pending, pending.hash)
  const receipt = await arcClient.getTransactionReceipt({ hash: pending.hash })
  if (receipt.status === 'reverted') return 'Source transaction failed'
  const response = await acrossApi('deposit/status', { depositTxnRef: pending.hash })
  const { status } = z.object({ status: z.string() }).parse(response)
  switch (status) {
    case 'filled':
      return 'Bridge completed'
    case 'refunded':
      return 'Bridge refunded'
    case 'expired':
      return 'Waiting for refund'
    default:
      return 'Bridge in progress'
  }
}

export function acrossFinished(status: string): boolean {
  return ['Bridge completed', 'Bridge refunded', 'Source transaction failed'].includes(status)
}

export async function updateAcrossPending(pending: AcrossPending, persist: Persist, hash?: string): Promise<void> {
  await withAcrossLock(async () => {
    const stored = acrossPendingSchema.parse(await acrossStorage.getItem(ACROSS_STORAGE_KEY, null))
    if (JSON.stringify(stored) !== JSON.stringify(acrossPendingSchema.parse(pending)))
      throw new Error('Bridge changed in another tab. Refresh.')
    if (!hash) {
      if (!acrossFinished(await acrossStatus(pending))) throw new Error('The bridge is still pending.')
      persist(null)
      return
    }
    const parsedHash = txHash.parse(hash)
    await verifyAcrossTransaction(pending, parsedHash)
    persist({ ...pending, hash: parsedHash })
  })
}

async function verifyAcrossTransaction(pending: AcrossPending, hash: Hex): Promise<void> {
  const transaction = await arcClient.getTransaction({ hash })
  if (
    !areAddressesEqual(transaction.from, pending.owner) ||
    !areAddressesEqual(transaction.to, ARC_SPOKE_POOL) ||
    transaction.nonce !== pending.nonce ||
    transaction.value !== 0n ||
    transaction.input.toLowerCase() !== pending.data.toLowerCase()
  )
    throw new Error('This transaction does not match the saved bridge.')
}
