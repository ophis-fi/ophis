import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { useAmountsToSignFromQuote } from 'modules/trade'

import { useGetPartialAmountToSignApprove } from './useGetPartialAmountToSignApprove'

import { useGetUserApproveAmountState } from '../state'

jest.mock('modules/trade', () => ({ useAmountsToSignFromQuote: jest.fn() }))
jest.mock('../state', () => ({ useGetUserApproveAmountState: jest.fn() }))

const quoteMock = jest.mocked(useAmountsToSignFromQuote)
const userMock = jest.mocked(useGetUserApproveAmountState)
const address = '0x1234567890123456789012345678901234567890'

describe('custom approval spending limit', () => {
  it.each([1, 10, 130, 4663, 8453])('preserves exactly 10 on chain %i after a quote increases', (chainId) => {
    const token = new Token(chainId, address, 6)
    const amount = CurrencyAmount.fromRawAmount(token, '10000000')
    userMock.mockReturnValue({ isModalOpen: false, amountSetByUser: amount })
    quoteMock.mockReturnValue({ maximumSendSellAmount: amount } as ReturnType<typeof useAmountsToSignFromQuote>)
    const { result, rerender } = renderHook(useGetPartialAmountToSignApprove)
    expect(result.current?.toExact()).toBe('10')

    quoteMock.mockReturnValue({
      maximumSendSellAmount: CurrencyAmount.fromRawAmount(token, '11000000'),
    } as ReturnType<typeof useAmountsToSignFromQuote>)
    rerender()
    expect(result.current?.toExact()).toBe('10')
  })

  it('does not reuse an approval for the same address on another chain', () => {
    const amount = CurrencyAmount.fromRawAmount(new Token(1, address, 6), '10000000')
    const next = CurrencyAmount.fromRawAmount(new Token(10, address, 6), '2000000')
    userMock.mockReturnValue({ isModalOpen: false, amountSetByUser: amount })
    quoteMock.mockReturnValue({ maximumSendSellAmount: next } as ReturnType<typeof useAmountsToSignFromQuote>)

    expect(renderHook(useGetPartialAmountToSignApprove).result.current).toBe(next)
  })
})
