/** @jest-environment node */
import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { decodeFunctionData, erc20Abi, type WalletClient } from 'viem'

import mockFixture from './fixtures/monadDeposit.json'
import { nearTransferSchema } from './nearDirect.schemas'
import { fundNearTransfer } from './nearDirectWallet.service'

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: () => mockClient,
}))
jest.mock('./nearDirect.service', () => ({
  ...jest.requireActual('./nearDirect.service'),
  getNearTokens: async () => [mockFixture.source, mockFixture.destination],
  getNearTransferStatus: async () => ({ status: 'PENDING_DEPOSIT' }),
}))
const mockClient = {
  getBalance: jest.fn(),
  estimateGas: jest.fn(),
  getGasPrice: jest.fn(),
  getTransactionCount: jest.fn(),
  readContract: jest.fn(),
}
const wallet = { request: jest.fn(), getChainId: jest.fn(), getAddresses: jest.fn(), sendTransaction: jest.fn() }
const transfer = nearTransferSchema.parse(mockFixture)

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(mockFixture.response.timestamp))
  wallet.getChainId.mockResolvedValue(143)
  wallet.getAddresses.mockResolvedValue([mockFixture.response.quoteRequest.refundTo])
  wallet.sendTransaction.mockResolvedValue('0x' + 'ab'.repeat(32))
  mockClient.getBalance.mockResolvedValue(10n ** 18n)
  mockClient.estimateGas.mockResolvedValue(50_000n)
  mockClient.getGasPrice.mockResolvedValue(1n)
  mockClient.getTransactionCount.mockResolvedValue(7)
  mockClient.readContract.mockImplementation(({ functionName }: { functionName: string }) =>
    Promise.resolve(functionName === 'decimals' ? 6 : 100_000_000n),
  )
})
afterEach(() => jest.restoreAllMocks())

it('journals an advisory nonce before a transfer but leaves nonce allocation to the wallet', async () => {
  const journal = jest.fn()
  await fundNearTransfer(wallet as unknown as WalletClient, transfer, journal)
  expect(journal).toHaveBeenCalledWith(7)
  expect(journal.mock.invocationCallOrder[0]).toBeLessThan(wallet.sendTransaction.mock.invocationCallOrder[0] ?? 0)
  const call = wallet.sendTransaction.mock.calls[0]?.[0]
  expect(areAddressesEqual(call.to, mockFixture.source.contractAddress)).toBe(true)
  expect(call.value).toBe(0n)
  expect(call).not.toHaveProperty('nonce')
  expect(decodeFunctionData({ abi: erc20Abi, data: call.data })).toEqual({
    functionName: 'transfer',
    args: [expect.any(String), 100_000_000n],
  })
})

it('does not sign when the wallet changes, gas is insufficient, or the quote expires', async () => {
  const journal = jest.fn()
  wallet.getChainId.mockResolvedValue(1)
  await expect(fundNearTransfer(wallet as unknown as WalletClient, transfer, journal)).rejects.toThrow(
    'Connect the refund wallet',
  )
  wallet.getChainId.mockResolvedValue(143)
  mockClient.getBalance.mockResolvedValue(1n)
  await expect(fundNearTransfer(wallet as unknown as WalletClient, transfer, journal)).rejects.toThrow('network fee')
  mockClient.getBalance.mockResolvedValue(10n ** 18n)
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(mockFixture.response.quoteRequest.deadline))
  await expect(fundNearTransfer(wallet as unknown as WalletClient, transfer, journal)).rejects.toThrow('Quote expired')
  expect(journal).not.toHaveBeenCalled()
  expect(wallet.sendTransaction).not.toHaveBeenCalled()
})
