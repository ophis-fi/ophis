import { expect, it, vi } from 'vitest'
import { JsonRpcProvider, id, ZeroHash, type TransactionReceipt } from 'ethers'
import type { WalletSession } from './wallet'
import { assertBaseReceiptFinality } from './base-finality'

function fixture() {
  const state = { chainId: 8453n, finalized: 100, changed: false }
  const receipt = { hash: id('transaction'), blockHash: id('receipt block'), blockNumber: 100, status: 1 } as TransactionReceipt
  const getBlock = vi.fn(async (tag: string | number) => tag === 'finalized'
    ? { number: state.finalized, hash: state.finalized === 100 ? receipt.blockHash : id('finalized') }
    : { number: tag, hash: state.changed ? id('changed') : tag === 100 ? receipt.blockHash : id('finalized') })
  const session = { provider: { getNetwork: async () => ({ chainId: state.chainId }), getBlock,
    send: async (method: string, params: unknown[]) => {
      expect(method).toBe('eth_getBlockByNumber'); expect(params[1]).toBe(false)
      const block = await getBlock(params[0] === 'finalized' ? 'finalized' : Number(BigInt(String(params[0]))))
      return { ...block, number: `0x${Number(block.number).toString(16)}` }
    } } } as unknown as WalletSession
  return { state, receipt, session, getBlock }
}

it('requires canonical Base finality without fetching the existing receipt again', async () => {
  const f = fixture()
  await expect(assertBaseReceiptFinality(f.session, f.receipt)).resolves.toBeUndefined()
  expect(f.getBlock).toHaveBeenCalledTimes(3)
  expect(f.getBlock.mock.calls.map(([tag]) => tag)).toEqual(['finalized', 100, 100])
})

it('does not combine an old receipt read with a newly finalized branch', async () => {
  const f = fixture()
  let observedAnchor = false
  f.getBlock.mockImplementation(async tag => {
    if (tag === 'finalized') {
      await Promise.resolve()
      observedAnchor = true
      return { number: 101, hash: id('new finalized branch') }
    }
    return { number: tag, hash: tag === 101 ? id('new finalized branch')
      : observedAnchor ? id('receipt orphaned on new branch') : f.receipt.blockHash }
  })
  await expect(assertBaseReceiptFinality(f.session, f.receipt)).rejects.toThrow('history changed')
  expect(f.getBlock.mock.calls.map(([tag]) => tag)).toEqual(['finalized', 100])
})

it('does not combine an ethers-cached receipt block with a newly finalized branch', async () => {
  const rpc = new JsonRpcProvider(undefined, 8453, { staticNetwork: true })
  const receipt = { hash: id('transaction'), blockHash: id('old block'), blockNumber: 100, status: 1 } as TransactionReceipt
  let reorg = false
  const send = vi.spyOn(rpc, 'send').mockImplementation(async (_method, params) => {
    const tag = (params as unknown[])[0], number = tag === 'finalized' ? 101 : Number(BigInt(String(tag)))
    return { number: `0x${number.toString(16)}`, hash: number === 101 ? id('new anchor') : reorg ? id('new block') : receipt.blockHash,
      parentHash: ZeroHash, timestamp: '0x1', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1',
      gasUsed: '0x0', miner: null, extraData: '0x', transactions: [] }
  })
  try {
    await rpc.getBlock(receipt.blockNumber); reorg = true
    await expect(assertBaseReceiptFinality({ provider: rpc } as WalletSession, receipt)).rejects.toThrow('history changed')
    expect(send.mock.calls.map(([, params]) => (params as unknown[])[0])).toEqual(['0x64', 'finalized', '0x64'])
  } finally { rpc.destroy() }
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
