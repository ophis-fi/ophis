import type { TransactionReceipt } from 'ethers'
import { deletePrivateState, readPrivateState, writePrivateState } from './storage'
import { historyHash } from '../base-history'
import type { WalletSession } from './wallet'

export interface HistoryReceipt { hash: string; blockNumber: number; blockHash: string }
let writing: Promise<unknown> = Promise.resolve()
let persistenceFailed = false
const unsaved = new Map<string, HistoryReceipt>()
const key = 'baseHistoryReceipts'
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const next = writing.catch(() => {}).then(action)
  writing = next.catch(() => {})
  return next
}
async function read(session: WalletSession): Promise<HistoryReceipt[]> {
  const value = await readPrivateState(session, key)
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16 || value.some(item => !item ||
    !historyHash(item.hash) || !historyHash(item.blockHash) || !Number.isSafeInteger(item.blockNumber) || item.blockNumber < 0) ||
    new Set(value.map(item => item.hash)).size !== value.length)
    throw new Error('Saved Base confirmation history is damaged. Preserve wallet data and pending transactions.')
  return value as HistoryReceipt[]
}
export function saveBaseHistoryReceipt(session: WalletSession, receipt: TransactionReceipt): Promise<void> {
  return serialized(async () => {
    try {
      if (receipt.status !== 1 || !historyHash(receipt.hash) || !historyHash(receipt.blockHash) ||
        !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0)
        throw new Error('A confirmed canonical Base receipt is required before updating private balances.')
      const current = { hash: receipt.hash.toLowerCase(), blockNumber: receipt.blockNumber, blockHash: receipt.blockHash.toLowerCase() }
      if (!unsaved.has(current.hash) && unsaved.size >= 16) throw new Error('Repair Base confirmation storage before continuing.')
      unsaved.set(current.hash, current)
      const receipts = [...new Map([...(await read(session)), ...unsaved.values()].map(item => [item.hash, item])).values()]
      if (receipts.length > 16) throw new Error('Verify existing Base confirmations before another operation.')
      await writePrivateState(session, key, receipts)
      unsaved.clear()
      persistenceFailed = false
    } catch (error) { persistenceFailed = true; throw error }
  })
}
export async function pendingBaseHistoryReceipts(session: WalletSession): Promise<HistoryReceipt[]> {
  await writing
  if (persistenceFailed) throw new Error('The Base confirmation could not be saved. Keep this page and its transaction record; repair storage before refreshing.')
  return read(session)
}
export async function refreshReorgedBaseHistoryReceipts(session: WalletSession, receipts: readonly HistoryReceipt[]): Promise<HistoryReceipt[]> {
  for (const saved of receipts) {
    const canonical = await session.provider.getBlock(saved.blockNumber)
    if (canonical?.hash?.toLowerCase() === saved.blockHash) continue
    // Query only the exact saved hash after a canonical mismatch; never resubmit it.
    const replacement = await session.provider.getTransactionReceipt(saved.hash)
    if (!replacement || replacement.status !== 1 || replacement.hash.toLowerCase() !== saved.hash ||
      (await session.provider.getBlock(replacement.blockNumber))?.hash?.toLowerCase() !== replacement.blockHash.toLowerCase())
      throw new Error('A saved Base transaction changed after a reorganization. Keep its record and refresh balances after it confirms; do not repeat it.')
    await saveBaseHistoryReceipt(session, replacement)
  }
  return pendingBaseHistoryReceipts(session)
}
export function clearBaseHistoryReceipts(session: WalletSession, expected: readonly HistoryReceipt[]): Promise<void> {
  return serialized(async () => {
    if (JSON.stringify(await read(session)) !== JSON.stringify(expected))
      throw new Error('A newer Base confirmation is still synchronizing. Keep the saved transaction and refresh balances.')
    if (expected.length) {
      try { await deletePrivateState(session, key) }
      catch (error) { persistenceFailed = true; throw error }
    }
  })
}
