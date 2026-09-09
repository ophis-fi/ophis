import { CurrencyAmount, Token } from '@cowprotocol/currency'
import { useWalletProvider } from '@cowprotocol/wallet-provider'
import { BigNumber } from '@ethersproject/bignumber'
import { Contract } from '@ethersproject/contracts'
import { Web3Provider } from '@ethersproject/providers'

import { renderHook } from '@testing-library/react'

import { useTransactionAdder } from 'legacy/state/enhancedTransactions/hooks'

import { useTokenContract } from 'common/hooks/useContract'

import { useApproveCallback } from './useApproveCallback'

import { LinguiWrapper } from '../../../../LinguiJestProvider'

jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: jest.fn() }))
jest.mock('common/hooks/useContract', () => ({ useTokenContract: jest.fn() }))
jest.mock('legacy/state/enhancedTransactions/hooks', () => ({ useTransactionAdder: jest.fn() }))

const tokenAddress = '0x1234567890123456789012345678901234567890'
const spender = '0x1111111111111111111111111111111111111111'
const approve = jest.fn().mockResolvedValue({ hash: '0x1234' })
const populate = jest.fn().mockResolvedValue({ to: tokenAddress, data: '0x095ea7b3', gasLimit: BigNumber.from(50000) })
const getChainId = jest.fn()
const send = jest.fn()
const estimate = jest.fn().mockResolvedValue(BigNumber.from(50000))

beforeEach(() => {
  jest.clearAllMocks()
  getChainId.mockResolvedValue(1)
  send.mockResolvedValue('0x1')
  jest.mocked(useWalletProvider).mockReturnValue({ send } as unknown as Web3Provider)
  jest.mocked(useTransactionAdder).mockReturnValue(jest.fn())
})

it.each([1, 10, 130, 4663, 8453])('sends exactly 10 tokens to approve on chain %i', async (chainId) => {
  const token = new Token(chainId, tokenAddress, 6, 'TEST')
  getChainId.mockResolvedValue(chainId)
  send.mockResolvedValue('0x' + chainId.toString(16))
  jest.mocked(useTokenContract).mockReturnValue({
    chainId,
    contract: {
      populateTransaction: { approve: populate },
      estimateGas: { approve: estimate },
      signer: { getChainId, sendTransaction: approve },
    },
  } as unknown as ReturnType<typeof useTokenContract>)
  const { result } = renderHook(() => useApproveCallback(token, spender), { wrapper: LinguiWrapper })

  await result.current(10000000n)

  expect(estimate).toHaveBeenCalledWith(spender, '10000000')
  expect(populate).toHaveBeenCalledWith(spender, '10000000', { gasLimit: expect.anything() })
  expect(approve).toHaveBeenCalledWith({ to: tokenAddress, data: '0x095ea7b3', gasLimit: expect.anything(), chainId })
})

it('does not approve a stale token on a newly selected wallet chain', async () => {
  const token = new Token(1, tokenAddress, 6, 'TEST')
  jest.mocked(useTokenContract).mockReturnValue({
    chainId: 10,
    contract: {
      populateTransaction: { approve: populate },
      estimateGas: { approve: estimate },
      signer: { getChainId, sendTransaction: approve },
    },
  } as unknown as ReturnType<typeof useTokenContract>)
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  const { result } = renderHook(() => useApproveCallback(token, spender), { wrapper: LinguiWrapper })

  await result.current(10000000n)

  expect(approve).not.toHaveBeenCalled()
  expect(estimate).not.toHaveBeenCalled()
  log.mockRestore()
})

it('rejects a network switch while gas estimation was pending', async () => {
  const token = new Token(1, tokenAddress, 6, 'TEST')
  jest.mocked(useTokenContract).mockReturnValue({
    chainId: 1,
    contract: {
      populateTransaction: { approve: populate },
      estimateGas: { approve: estimate },
      signer: { getChainId, sendTransaction: approve },
    },
  } as unknown as ReturnType<typeof useTokenContract>)
  estimate.mockImplementationOnce(async () => {
    send.mockResolvedValue('0xa')
    return BigNumber.from(50000)
  })
  const { result } = renderHook(() => useApproveCallback(token, spender), { wrapper: LinguiWrapper })
  await expect(result.current(10000000n)).rejects.toThrow('Wallet network changed')
  expect(approve).not.toHaveBeenCalled()
})

it('rejects an amount for a different token before contacting the wallet', async () => {
  const token = new Token(1, tokenAddress, 6, 'TEST')
  jest.mocked(useTokenContract).mockReturnValue({
    chainId: 1,
    contract: {
      populateTransaction: { approve: populate },
      estimateGas: { approve: estimate },
      signer: { getChainId, sendTransaction: approve },
    },
  } as unknown as ReturnType<typeof useTokenContract>)
  const wrongToken = new Token(10, tokenAddress, 6, 'TEST')
  const { result } = renderHook(() => useApproveCallback(token, spender), { wrapper: LinguiWrapper })
  await expect(result.current(CurrencyAmount.fromRawAmount(wrongToken, '10000000'))).rejects.toThrow('Approval token')
  expect(estimate).not.toHaveBeenCalled()
  expect(approve).not.toHaveBeenCalled()
})

// Exercise the installed ethers provider: its fixed network remains 1 even after
// eth_chainId changes, so mocking signer.getChainId alone misses this race.
it('reads the live wallet chain even when ethers caches the original network', async () => {
  const token = new Token(1, tokenAddress, 6, 'TEST')
  let liveChainId = '0x1'
  const request = jest.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return liveChainId
    throw new Error('Unexpected wallet request: ' + method)
  })
  const provider = new Web3Provider({ request }, 1)
  const signer = provider.getUncheckedSigner('0x2222222222222222222222222222222222222222')
  const contract = new Contract(
    tokenAddress,
    ['function approve(address spender, uint256 amount) returns (bool)'],
    signer,
  )
  jest.mocked(useWalletProvider).mockReturnValue(provider)
  jest.mocked(useTokenContract).mockReturnValue({
    chainId: 1,
    contract: {
      populateTransaction: contract.populateTransaction,
      estimateGas: { approve: estimate },
      signer,
    },
  } as unknown as ReturnType<typeof useTokenContract>)
  expect(await signer.getChainId()).toBe(1)
  liveChainId = '0xa'
  expect(await signer.getChainId()).toBe(1)
  const { result } = renderHook(() => useApproveCallback(token, spender), { wrapper: LinguiWrapper })
  await expect(result.current(10000000n)).rejects.toThrow('Wallet network changed')
  expect(request).toHaveBeenCalledWith({ method: 'eth_chainId', params: [] })
  expect(request.mock.calls.some(([call]) => call.method === 'eth_sendTransaction')).toBe(false)
})
