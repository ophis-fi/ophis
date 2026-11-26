import { Token } from '@cowprotocol/currency'

import { act, renderHook, waitFor } from '@testing-library/react'

import { useNearFundingBalance } from './useNearFundingBalance'

import fixture from '../fixtures/confidentialMonadDeposit.json'

let mockWallet = { uid: 'wallet', getChainId: async () => 143, request: jest.fn() }
const mockRead = jest.fn()
const sender = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
let mockAccount = sender
let mockChainId = 143
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ account: mockAccount }) }))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletChainId: () => mockChainId }))
jest.mock('modules/cctp', () => ({ useBridgeWallet: () => mockWallet }))
jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: () => ({ readContract: mockRead }),
}))

it('uses only the current sending account and discards a balance that arrives after an account change', async () => {
  const source = fixture.source
  const currency = new Token(143, source.contractAddress, source.decimals, source.symbol)
  let finish: (amount: bigint) => void = () => undefined
  mockRead.mockImplementation(({ functionName, args }) => {
    if (functionName === 'decimals') return Promise.resolve(source.decimals)
    return args[0] === sender
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve(1000001n)
  })
  const { result, rerender } = renderHook(({ refund }) => useNearFundingBalance(source, currency, refund), {
    initialProps: { refund: sender },
  })
  await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(2))
  mockAccount = other
  rerender({ refund: sender })
  await act(async () => {
    finish(100000000n)
  })
  expect(result.current).toBeNull()
  rerender({ refund: other })
  await waitFor(() => expect(result.current?.quotient.toString()).toBe('1000001'))
  rerender({ refund: sender })
  expect(result.current).toBeNull()
})

it('separates two wallets with the same account and ignores a late read after a chain switch', async () => {
  mockAccount = sender
  mockChainId = 143
  mockWallet = { ...mockWallet, uid: 'first provider' }
  mockRead.mockClear()
  const source = fixture.source
  const currency = new Token(mockChainId, source.contractAddress, source.decimals, source.symbol)
  mockRead.mockImplementation(({ functionName }) =>
    Promise.resolve(functionName === 'decimals' ? source.decimals : 1000001n),
  )
  const { result, rerender } = renderHook(() => useNearFundingBalance(source, currency, sender))
  await waitFor(() => expect(result.current?.quotient.toString()).toBe('1000001'))
  let finish: (amount: bigint) => void = () => undefined
  mockRead.mockImplementation(({ functionName }) =>
    functionName === 'decimals'
      ? Promise.resolve(source.decimals)
      : new Promise((resolve) => {
          finish = resolve
        }),
  )
  mockWallet = { ...mockWallet, uid: 'second provider' }
  rerender()
  expect(result.current).toBeNull()
  await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(4))
  mockChainId = 196
  rerender()
  await act(async () => {
    finish(2000002n)
  })
  expect(result.current).toBeNull()
  expect(mockRead).toHaveBeenCalledTimes(4)
  mockRead.mockImplementation(({ functionName }) =>
    Promise.resolve(functionName === 'decimals' ? source.decimals : 3000003n),
  )
  mockChainId = 143
  rerender()
  expect(result.current).toBeNull()
  await waitFor(() => expect(result.current?.quotient.toString()).toBe('3000003'))
})
