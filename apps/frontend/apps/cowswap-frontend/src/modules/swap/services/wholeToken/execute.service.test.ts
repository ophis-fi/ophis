import { BigNumber } from '@ethersproject/bignumber'
import { JsonRpcProvider, TransactionReceipt, TransactionResponse, Web3Provider } from '@ethersproject/providers'

import { executeDirectSwap, waitForDirectReceipt } from './execute.service'
import { DirectQuote } from './router.service'

jest.mock('./router.service', () => ({ buildDirectTransaction: () => ({ value: '100', chainId: 1 }) }))
const account = '0x00000000000000000000000000000000FEEDbabe'
const sendTransaction = jest.fn().mockResolvedValue({ hash: '0x123' })
const wallet = {
  getSigner: () => ({ getAddress: async () => account, sendTransaction }),
  send: jest.fn().mockResolvedValue('0x1'),
} as unknown as Web3Provider
const rpc = {
  getTransactionReceipt: jest.fn().mockResolvedValue(null),
  getBalance: jest.fn().mockResolvedValue(BigNumber.from(1000)),
  estimateGas: jest.fn().mockResolvedValue(BigNumber.from(100)),
} as unknown as JsonRpcProvider
const quote = { account, maxTotal: 200n, gasLimit: 120n, quotedAt: Date.now() } as DirectQuote
beforeEach(() => sendTransaction.mockClear())
it('submits the reviewed limits only after wallet, balance and simulation checks', async () => {
  await executeDirectSwap(wallet, rpc, quote, () => true)
  expect(sendTransaction).toHaveBeenCalledWith({ value: '100', chainId: 1 })
})
it('rejects an edited form without requesting a signature', async () => {
  await expect(executeDirectSwap(wallet, rpc, quote, () => false)).rejects.toThrow('Quote changed')
  expect(sendTransaction).not.toHaveBeenCalled()
})
it.each([
  { patch: { quotedAt: 0 }, message: 'expired' },
  { patch: { account: '0x0000000000000000000000000000000000000001' }, message: 'Wallet changed' },
  { patch: { maxTotal: 1001n }, message: 'Insufficient' },
  { patch: { gasLimit: 99n }, message: 'Gas estimate changed' },
])('rejects $message without requesting a signature', async ({ patch, message }) => {
  await expect(executeDirectSwap(wallet, rpc, { ...quote, ...patch }, () => true)).rejects.toThrow(message)
  expect(sendTransaction).not.toHaveBeenCalled()
})
it('rejects a changed network', async () => {
  jest.mocked(wallet.send).mockResolvedValueOnce('0x64')
  await expect(executeDirectSwap(wallet, rpc, quote, () => true)).rejects.toThrow('Wallet changed')
  expect(sendTransaction).not.toHaveBeenCalled()
})
it('accepts repricing receipts but never reports a cancelled replacement as success', async () => {
  const error = { code: 'TRANSACTION_REPLACED', cancelled: false, receipt: { status: 1, transactionHash: '0x456' } }
  const tx = { wait: jest.fn().mockRejectedValue(error) } as unknown as TransactionResponse
  expect(await waitForDirectReceipt(tx)).toBe(error.receipt)
  const onReplaced = jest.fn()
  error.cancelled = true
  await expect(waitForDirectReceipt(tx, onReplaced)).rejects.toBe(error)
  expect(onReplaced).toHaveBeenCalledWith('0x456', true)
})

it('blocks a fresh quote for the same request while the broadcast is unresolved', async () => {
  await expect(executeDirectSwap(wallet, rpc, { ...quote }, () => true, '0x123')).rejects.toThrow('Previous swap')
  expect(sendTransaction).not.toHaveBeenCalled()
})
it('allows a newly reviewed swap once the previous transaction is confirmed', async () => {
  jest.mocked(rpc.getTransactionReceipt).mockResolvedValueOnce({ status: 1 } as TransactionReceipt)
  await executeDirectSwap(wallet, rpc, { ...quote }, () => true, '0x123')
  expect(sendTransaction).toHaveBeenCalledTimes(1)
})
