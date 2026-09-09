import { CurrencyAmount, Token } from '@cowprotocol/currency'
import { BigNumber } from '@ethersproject/bignumber'

import { renderHook } from '@testing-library/react'

import { useTransactionAdder } from 'legacy/state/enhancedTransactions/hooks'

import { useTokenContract } from 'common/hooks/useContract'

import { useApproveCallback } from './useApproveCallback'

import { LinguiWrapper } from '../../../../LinguiJestProvider'

jest.mock('common/hooks/useContract', () => ({ useTokenContract: jest.fn() }))
jest.mock('legacy/state/enhancedTransactions/hooks', () => ({ useTransactionAdder: jest.fn() }))

const tokenAddress = '0x1234567890123456789012345678901234567890'
const spender = '0x1111111111111111111111111111111111111111'
const approve = jest.fn().mockResolvedValue({ hash: '0x1234' })
const populate = jest.fn().mockResolvedValue({ to: tokenAddress, data: '0x095ea7b3', gasLimit: BigNumber.from(50000) })
const getChainId = jest.fn()
const estimate = jest.fn().mockResolvedValue(BigNumber.from(50000))

beforeEach(() => {
  jest.clearAllMocks()
  getChainId.mockResolvedValue(1)
  jest.mocked(useTransactionAdder).mockReturnValue(jest.fn())
})

it.each([1, 10, 130, 4663, 8453])('sends exactly 10 tokens to approve on chain %i', async (chainId) => {
  const token = new Token(chainId, tokenAddress, 6, 'TEST')
  getChainId.mockResolvedValue(chainId)
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
    getChainId.mockResolvedValue(10)
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
