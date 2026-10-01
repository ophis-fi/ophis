import { OrderKind } from '@cowprotocol/cow-sdk'
import { Token } from '@cowprotocol/currency'

import { act, renderHook } from '@testing-library/react'

import { useOnSwitchTokens } from './useOnSwitchTokens'

const input = new Token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC')
const output = new Token(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USDC')
let mockState = { inputCurrency: input, outputCurrency: output, orderKind: OrderKind.BUY }
const mockSameChainSwitch = jest.fn()
const mockNavigate = jest.fn()
const mockUpdateState = jest.fn()
jest.mock('modules/trade', () => ({
  useSwitchTokensPlaces: () => mockSameChainSwitch,
  useTradeNavigate: () => mockNavigate,
}))
jest.mock('./useSwapDerivedState', () => ({ useSwapDerivedState: () => mockState }))
jest.mock('./useUpdateSwapRawState', () => ({ useUpdateSwapRawState: () => mockUpdateState }))

beforeEach(() => {
  jest.clearAllMocks()
  mockState = { inputCurrency: input, outputCurrency: output, orderKind: OrderKind.BUY }
})

it('reverses both networks and token addresses, clearing the old amount and recipient', () => {
  const { result } = renderHook(() => useOnSwitchTokens())
  act(() => result.current())
  expect(mockNavigate).toHaveBeenCalledWith(
    output.chainId,
    { inputCurrencyId: output.address, outputCurrencyId: input.address },
    { targetChainId: input.chainId, kind: OrderKind.SELL, amount: '', clearRecipient: true },
  )
  expect(mockUpdateState).toHaveBeenCalledWith({
    inputCurrencyAmount: null,
    outputCurrencyAmount: null,
    orderKind: OrderKind.SELL,
    recipient: null,
    recipientAddress: null,
  })
  expect(mockSameChainSwitch).not.toHaveBeenCalled()
})

it('retains the existing same-chain reversal', () => {
  mockState.outputCurrency = new Token(1, output.address, 6, 'OTHER')
  const { result } = renderHook(() => useOnSwitchTokens())
  act(() => result.current())
  expect(mockSameChainSwitch).toHaveBeenCalledTimes(1)
  expect(mockNavigate).not.toHaveBeenCalled()
})

it('does not navigate a non-settlement destination into the standard source route', () => {
  mockState.outputCurrency = new Token(143, output.address, 6, 'USDC')
  const { result } = renderHook(() => useOnSwitchTokens())
  act(() => result.current())
  expect(mockNavigate).not.toHaveBeenCalled()
  expect(mockUpdateState).not.toHaveBeenCalled()
  expect(mockSameChainSwitch).not.toHaveBeenCalled()
})
