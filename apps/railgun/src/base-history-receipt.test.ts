import { beforeEach, expect, it, vi } from 'vitest'
import { id, type TransactionReceipt } from 'ethers'
import type { WalletSession } from './wallet'
const state = vi.hoisted(() => ({ records: new Map<string, unknown>(), writes: vi.fn(), deletes: vi.fn() }))
vi.mock('./storage', () => ({
  readPrivateState: async (_session: unknown, key: string) => structuredClone(state.records.get(key)),
  writePrivateState: async (_session: unknown, key: string, value: unknown) => { state.writes(); state.records.set(key, structuredClone(value)) },
  deletePrivateState: async (_session: unknown, key: string) => { state.deletes(); state.records.delete(key) },
}))
import { saveBaseHistoryReceipt, pendingBaseHistoryReceipts, refreshReorgedBaseHistoryReceipts, clearBaseHistoryReceipts } from './base-history-receipt'
const receipt = (suffix = 'one', block = 56_000_000) => ({ status: 1, hash: id(suffix), blockNumber: block, blockHash: id(`block:${block}`) }) as TransactionReceipt
const session = { provider: { getBlock: vi.fn(), getTransactionReceipt: vi.fn() } } as unknown as WalletSession
beforeEach(() => { state.records.clear(); vi.clearAllMocks() })

it('serializes pending receipts and retains them across an ordinary reload/read until exact-list verification', async () => {
  await Promise.all([saveBaseHistoryReceipt(session, receipt()), saveBaseHistoryReceipt(session, receipt('two', 56_000_001))])
  const saved = await pendingBaseHistoryReceipts(session)
  expect(saved).toHaveLength(2)
  state.records.set('pendingSwap', { proof: 'synthetic' })
  await expect(clearBaseHistoryReceipts(session, [saved[0]])).rejects.toThrow('newer Base')
  expect(await pendingBaseHistoryReceipts(session)).toEqual(saved)
  await clearBaseHistoryReceipts(session, saved)
  expect(await pendingBaseHistoryReceipts(session)).toEqual([])
  expect(state.records.get('pendingSwap')).toEqual({ proof: 'synthetic' })
})

it('reuses a still-canonical receipt without another receipt RPC', async () => {
  const value = receipt(); await saveBaseHistoryReceipt(session, value)
  vi.mocked(session.provider.getBlock).mockResolvedValue({ hash: value.blockHash } as never)
  expect(await refreshReorgedBaseHistoryReceipts(session, await pendingBaseHistoryReceipts(session))).toMatchObject([{ hash: value.hash }])
  expect(session.provider.getTransactionReceipt).not.toHaveBeenCalled()
})

it('updates the exact saved transaction after canonical re-inclusion and preserves absent transactions', async () => {
  const initial = receipt(), replacement = receipt('one', 56_000_004)
  await saveBaseHistoryReceipt(session, initial)
  vi.mocked(session.provider.getBlock).mockImplementation(async number => ({ hash: id(`block:${Number(number) + (number === initial.blockNumber ? 1 : 0)}`) }) as never)
  vi.mocked(session.provider.getTransactionReceipt).mockResolvedValue(null)
  await expect(refreshReorgedBaseHistoryReceipts(session, await pendingBaseHistoryReceipts(session))).rejects.toThrow('reorganization')
  expect((await pendingBaseHistoryReceipts(session))[0].blockHash).toBe(initial.blockHash)
  vi.mocked(session.provider.getTransactionReceipt).mockResolvedValue(replacement)
  expect(await refreshReorgedBaseHistoryReceipts(session, await pendingBaseHistoryReceipts(session))).toMatchObject([{ blockNumber: replacement.blockNumber }])
  expect(session.provider.getTransactionReceipt).toHaveBeenLastCalledWith(initial.hash)
})

it('keeps a persistence failure sticky for ordinary reads until the same receipt is successfully saved', async () => {
  state.writes.mockImplementationOnce(() => { throw new Error('disk full') })
  await expect(saveBaseHistoryReceipt(session, receipt())).rejects.toThrow('disk full')
  await expect(pendingBaseHistoryReceipts(session)).rejects.toThrow('could not be saved')
  await expect(pendingBaseHistoryReceipts(session)).rejects.toThrow('could not be saved')
  await saveBaseHistoryReceipt(session, receipt('second'))
  expect(await pendingBaseHistoryReceipts(session)).toHaveLength(2)
})
