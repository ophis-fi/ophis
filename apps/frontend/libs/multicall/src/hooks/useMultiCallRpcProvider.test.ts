import { renderHook } from '@testing-library/react'

import { useMultiCallRpcProvider } from './useMultiCallRpcProvider'

const walletProvider = { source: 'wallet' }
const rpcProvider = { source: 'configured-rpc' }
const mockGetRpcProvider = jest.fn().mockReturnValue(rpcProvider)
const mockWalletChainId = jest.fn()
const mockWalletProvider = jest.fn(() => walletProvider)
const mockContext = jest.fn()
const mockIsBraveWallet = jest.fn()
const mockIsWalletConnect = jest.fn()

jest.mock('@cowprotocol/common-const', () => ({ getRpcProvider: (chainId: number) => mockGetRpcProvider(chainId) }))
jest.mock('@cowprotocol/wallet', () => ({
  useIsBraveWallet: () => mockIsBraveWallet(),
  useIsWalletConnect: () => mockIsWalletConnect(),
}))
jest.mock('@cowprotocol/wallet-provider', () => ({
  useWalletChainId: () => mockWalletChainId(),
  useWalletProvider: () => mockWalletProvider(),
}))
jest.mock('jotai/index', () => ({ useAtomValue: () => mockContext() }))
jest.mock('../state/multiCallContextAtom', () => ({ multiCallContextAtom: {} }))

beforeEach(() => {
  jest.clearAllMocks()
  mockWalletChainId.mockReturnValue(5042)
  mockContext.mockReturnValue({ chainId: 5042 })
  mockIsBraveWallet.mockReturnValue(false)
  mockIsWalletConnect.mockReturnValue(false)
})

it.each([1, 10, 56, 100, 130, 137, 4663, 5042, 8453, 9745, 42161, 43114, 57073, 59144])(
  'uses the configured chain RPC for WalletConnect reads on %i',
  (chainId) => {
    mockWalletChainId.mockReturnValue(chainId)
    mockContext.mockReturnValue({ chainId })
    mockIsWalletConnect.mockReturnValue(true)
    const { result } = renderHook(useMultiCallRpcProvider)
    expect(result.current).toBe(rpcProvider)
    expect(mockGetRpcProvider).toHaveBeenCalledWith(chainId)
  },
)

it('keeps the viewed chain ahead of the WalletConnect wallet chain', () => {
  mockIsWalletConnect.mockReturnValue(true)
  mockWalletChainId.mockReturnValue(1)
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(rpcProvider)
  expect(mockGetRpcProvider).toHaveBeenCalledWith(5042)
})

it('preserves injected-wallet reads on the same chain', () => {
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(walletProvider)
  expect(mockGetRpcProvider).not.toHaveBeenCalled()
})

it('preserves the Brave RPC workaround', () => {
  mockIsBraveWallet.mockReturnValue(true)
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(rpcProvider)
  expect(mockGetRpcProvider).toHaveBeenCalledWith(5042)
})

it('uses the wallet chain when no viewing context exists', () => {
  mockIsWalletConnect.mockReturnValue(true)
  mockContext.mockReturnValue(null)
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(rpcProvider)
  expect(mockGetRpcProvider).toHaveBeenCalledWith(5042)
})

it('does not request a configured RPC without a known chain', () => {
  mockIsWalletConnect.mockReturnValue(true)
  mockContext.mockReturnValue(null)
  mockWalletChainId.mockReturnValue(undefined)
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(walletProvider)
  expect(mockGetRpcProvider).not.toHaveBeenCalled()
})
