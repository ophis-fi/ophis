import { StaticJsonRpcProvider } from '@ethersproject/providers'

import { renderHook } from '@testing-library/react'

import { useMultiCallRpcProvider } from './useMultiCallRpcProvider'

import { ArcReadProvider } from '../utils/ArcReadProvider'

const walletProvider = { source: 'wallet' }
const rpcProvider = { source: 'configured-rpc' }
const mockGetRpcProvider = jest.fn().mockReturnValue(rpcProvider)
const mockWalletChainId = jest.fn()
const mockWalletProvider = jest.fn(() => walletProvider)
const mockContext = jest.fn()
const mockIsBraveWallet = jest.fn()
const mockIsWalletConnect = jest.fn()

jest.mock('@cowprotocol/common-const', () => ({
  ARC_CHAIN_ID: 5042,
  ARC_LOCAL: false,
  ARC_RPC_URL: 'https://arc-rpc.publicnode.com',
  ARC_FALLBACK_RPC_URL: 'https://rpc.blockdaemon.mainnet.arc.io',
  RPC_URLS: { 5042: 'https://arc-rpc.publicnode.com' },
  getRpcProvider: (chainId: number) => mockGetRpcProvider(chainId),
}))
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
  mockWalletChainId.mockReturnValue(1)
  mockContext.mockReturnValue({ chainId: 1 })
  mockIsBraveWallet.mockReturnValue(false)
  mockIsWalletConnect.mockReturnValue(false)
})

it.each([1, 10, 56, 100, 130, 137, 4663, 8453, 9745, 42161, 43114, 57073, 59144])(
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
  mockWalletChainId.mockReturnValue(10)
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(rpcProvider)
  expect(mockGetRpcProvider).toHaveBeenCalledWith(1)
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
  expect(mockGetRpcProvider).toHaveBeenCalledWith(1)
})

it('uses the wallet chain when no viewing context exists', () => {
  mockIsWalletConnect.mockReturnValue(true)
  mockContext.mockReturnValue(null)
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(rpcProvider)
  expect(mockGetRpcProvider).toHaveBeenCalledWith(1)
})

it('does not request a configured RPC without a known chain', () => {
  mockIsWalletConnect.mockReturnValue(true)
  mockContext.mockReturnValue(null)
  mockWalletChainId.mockReturnValue(undefined)
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBe(walletProvider)
  expect(mockGetRpcProvider).not.toHaveBeenCalled()
})

const mockSend = jest.spyOn(StaticJsonRpcProvider.prototype, 'send')

afterEach(() => mockSend.mockReset())

it('fails over Arc balance reads without using the connected wallet', async () => {
  mockWalletChainId.mockReturnValue(5042)
  mockContext.mockReturnValue({ chainId: 5042 })
  mockSend.mockImplementation(async function (this: StaticJsonRpcProvider, method: string) {
    if (this.connection.url.includes('publicnode')) throw new Error('429 rate limit exceeded')
    if (method === 'eth_blockNumber') return '0x64'
    return '0x1234'
  })
  const { result } = renderHook(useMultiCallRpcProvider)
  expect(result.current).toBeInstanceOf(ArcReadProvider)
  await expect(result.current?.call({ to: '0x3600000000000000000000000000000000000000' })).resolves.toBe('0x1234')
  expect(
    mockSend.mock.instances.some((provider) => provider.connection.url === 'https://rpc.blockdaemon.mainnet.arc.io'),
  ).toBe(true)
  expect(mockGetRpcProvider).not.toHaveBeenCalled()
})

it('loads Arc balances when the browser blocks every arc.io subdomain', async () => {
  mockWalletChainId.mockReturnValue(5042)
  mockContext.mockReturnValue({ chainId: 5042 })
  mockSend.mockImplementation(async function (this: StaticJsonRpcProvider) {
    if (new URL(this.connection.url).hostname.endsWith('.arc.io')) throw new Error('net::ERR_BLOCKED_BY_CLIENT')
    return '0x1234'
  })
  const { result } = renderHook(useMultiCallRpcProvider)
  await expect(result.current?.call({ to: '0x3600000000000000000000000000000000000000' })).resolves.toBe('0x1234')
  expect(mockSend).toHaveBeenCalledTimes(1)
})

it('rejects when both Arc read endpoints fail', async () => {
  mockWalletChainId.mockReturnValue(5042)
  mockContext.mockReturnValue(null)
  mockSend.mockRejectedValue(new Error('429 rate limit exceeded'))
  const { result } = renderHook(useMultiCallRpcProvider)
  await expect(result.current?.call({ to: '0x3600000000000000000000000000000000000000' })).rejects.toThrow()
})

it('does not retry transaction submission on the fallback endpoint', async () => {
  mockSend.mockRejectedValue(new Error('write rejected'))
  const provider = new ArcReadProvider()
  await expect(provider.send('eth_sendRawTransaction', ['0x1234'])).rejects.toThrow('write rejected')
  expect(mockSend).toHaveBeenCalledTimes(1)
})
