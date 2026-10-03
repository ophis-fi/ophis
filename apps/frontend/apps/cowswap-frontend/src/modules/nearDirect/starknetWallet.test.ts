/** @jest-environment node */
import { STRK_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'

import { UserRejectedRequestError } from 'viem'

import fixture from './fixtures/starknetDeposit.json'
import { NearTransfer, nearTransferSchema } from './nearDirect.schemas'
import { fundStarknetTransfer, STARKNET_MAINNET } from './starknetWallet.service'

jest.mock('./nearDirect.service', () => ({
  ...jest.requireActual('./nearDirect.service'),
  getNearTokens: async () => [mockTransfer.source, mockTransfer.destination],
  getNearTransferStatus: async () => ({ status: mockStatus }),
}))

const wallet = {
  id: 'braavos',
  name: 'Braavos',
  version: '1',
  icon: '',
  request: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
}
const mockTransfer = nearTransferSchema.parse(fixture)
let mockStatus: NearTransfer['status'] = 'PENDING_DEPOSIT'
const invokeCalls = (): unknown[] =>
  wallet.request.mock.calls.filter(([request]) => request.type === 'wallet_addInvokeTransaction')

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.response.timestamp))
  mockStatus = 'PENDING_DEPOSIT'
  wallet.request.mockImplementation(async ({ type }: { type: string }) => {
    if (type === 'wallet_requestAccounts') return [mockTransfer.response.quoteRequest.refundTo]
    if (type === 'wallet_requestChainId') return `0x${STARKNET_MAINNET.toString(16)}`
    return { transaction_hash: '0x' + '12'.repeat(32) }
  })
})
afterEach(() => jest.restoreAllMocks())

it('sends exactly the quoted STRK deposit, with a durable journal before invocation', async () => {
  const journal = jest.fn(async () => expect(invokeCalls()).toHaveLength(0))
  await fundStarknetTransfer(wallet, mockTransfer, journal)
  expect(journal).toHaveBeenCalledTimes(1)
  expect(invokeCalls()).toEqual([
    [
      {
        type: 'wallet_addInvokeTransaction',
        params: {
          calls: [
            {
              contract_address: STRK_NATIVE_CURRENCY_ADDRESS,
              entry_point: 'transfer',
              calldata: [mockTransfer.response.quote.depositAddress, '0x4e1003b28d9280000', '0x0'],
            },
          ],
        },
      },
    ],
  ])
})

it('blocks bad signatures, detected deposits, wrong networks, expired quotes and failed persistence', async () => {
  const journal = jest.fn()
  const tampered = { ...mockTransfer, response: { ...mockTransfer.response, signature: 'forged' } }
  await expect(fundStarknetTransfer(wallet, tampered, journal)).rejects.toThrow('signature')
  mockStatus = 'PROCESSING'
  await expect(fundStarknetTransfer(wallet, mockTransfer, journal)).rejects.toThrow('already been detected')
  mockStatus = 'PENDING_DEPOSIT'
  wallet.request
    .mockResolvedValueOnce([mockTransfer.response.quoteRequest.refundTo])
    .mockResolvedValueOnce('0x534e5f5345504f4c4941')
  await expect(fundStarknetTransfer(wallet, mockTransfer, journal)).rejects.toThrow('mainnet')
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(mockTransfer.response.quoteRequest.deadline))
  await expect(fundStarknetTransfer(wallet, mockTransfer, journal)).rejects.toThrow('expired')
  expect(journal).not.toHaveBeenCalled()
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.response.timestamp))
  await expect(
    fundStarknetTransfer(wallet, mockTransfer, async () => {
      throw new Error('storage full')
    }),
  ).rejects.toThrow('storage full')
  expect(invokeCalls()).toHaveLength(0)
})

it('rechecks the account after journaling and distinguishes rejection from uncertain broadcast', async () => {
  await expect(
    fundStarknetTransfer(wallet, mockTransfer, async () => {
      wallet.request.mockResolvedValueOnce(['0x999'])
    }),
  ).rejects.toThrow('refund wallet')
  expect(invokeCalls()).toHaveLength(0)
  for (const failure of [{ code: 113 }, new Error('connection lost after broadcast')]) {
    await expect(
      fundStarknetTransfer(wallet, mockTransfer, async () => {
        wallet.request
          .mockResolvedValueOnce([mockTransfer.response.quoteRequest.refundTo])
          .mockResolvedValueOnce(`0x${STARKNET_MAINNET.toString(16)}`)
          .mockRejectedValueOnce(failure)
      }),
    ).rejects.toThrow(failure instanceof Error ? failure : UserRejectedRequestError)
  }
})
