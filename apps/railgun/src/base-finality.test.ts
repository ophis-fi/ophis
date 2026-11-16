import { expect, it, vi } from 'vitest'
import { id, type TransactionReceipt } from 'ethers'
import type { WalletSession } from './wallet'
import { assertBaseReceiptFinality } from './base-finality'

function fixture() {
  const state = { chainId: 8453n, finalized: 100, changed: false }
  const receipt = { hash: id('transaction'), blockHash: id('receipt block'), blockNumber: 100, status: 1 } as TransactionReceipt
  const getBlock = vi.fn(async (tag: string | number) => tag === 'finalized'
    ? { number: state.finalized, hash: state.finalized === 100 ? receipt.blockHash : id('finalized') }
    : { number: tag, hash: state.changed ? id('changed') : tag === 100 ? receipt.blockHash : id('finalized') })
  const session = { provider: { getNetwork: async () => ({ chainId: state.chainId }), getBlock } } as unknown as WalletSession
  return { state, receipt, session, getBlock }
}

it('requires canonical Base finality without fetching the existing receipt again', async () => {
  const f = fixture()
  await expect(assertBaseReceiptFinality(f.session, f.receipt)).resolves.toBeUndefined()
  expect(f.getBlock).toHaveBeenCalledTimes(3)
})

it('keeps included receipts pending and rejects wrong-network or malformed evidence', async () => {
  const f = fixture(); f.state.finalized = 99
  await expect(assertBaseReceiptFinality(f.session, f.receipt)).rejects.toThrow('awaiting Base finality')
  f.state.chainId = 1n
  await expect(assertBaseReceiptFinality(f.session, f.receipt)).rejects.toThrow('evidence is unavailable')
  f.state.chainId = 8453n
  await expect(assertBaseReceiptFinality(f.session, { ...f.receipt, status: 0 } as TransactionReceipt)).rejects.toThrow('evidence is unavailable')
})

it.each(['receipt reorg', 'wrong height', 'finalized reorg'])('rejects %s before a journal can be cleared', async reason => {
  const f = fixture(); f.state.finalized = 101
  if (reason === 'receipt reorg') f.state.changed = true
  if (reason === 'wrong height') f.getBlock.mockImplementation(async tag => ({ number: tag === 'finalized' ? 101 : 99, hash: f.receipt.blockHash }))
  if (reason === 'finalized reorg') f.getBlock.mockImplementation(async tag => tag === 'finalized'
    ? { number: 101, hash: id('finalized') }
    : { number: tag, hash: tag === 100 ? f.receipt.blockHash : id('changed') })
  await expect(assertBaseReceiptFinality(f.session, f.receipt)).rejects.toThrow('history changed')
})
