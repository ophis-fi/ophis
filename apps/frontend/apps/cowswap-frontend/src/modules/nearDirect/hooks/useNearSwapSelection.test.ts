import { OrderKind } from '@cowprotocol/cow-sdk'
import { Token } from '@cowprotocol/currency'

import { act, renderHook } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { useNearSwapSelection } from './useNearSwapSelection'

const mockNavigate = jest.fn()
const mockUpdateState = jest.fn()
jest.mock('modules/trade', () => ({
  useTradeNavigate: () => mockNavigate,
  useTradeState: () => ({ updateState: mockUpdateState }),
}))
beforeEach(() => jest.clearAllMocks())

it('resets old precision only when the source changes', () => {
  const address = '0x1111111111111111111111111111111111111111'
  const initial = { input: new Token(143, address, 18, 'OLD'), output: null, amount: '0.123456789' }
  const replacement = new Token(143, address, 6, 'USDC')
  const { result } = renderHook(() => useNearSwapSelection(initial, jest.fn()))
  act(() => result.current.select(Field.OUTPUT, replacement))
  expect(result.current.selection.amount).toBe(initial.amount)
  act(() => result.current.select(Field.INPUT, replacement))
  expect(result.current.selection.input).toBe(replacement)
  expect(result.current.selection.amount).toBe('')
})

it.each(['select', 'reverse'])('clears standard amounts and URL amounts when exiting via %s', (action) => {
  const address = '0x1111111111111111111111111111111111111111'
  const input = new Token(143, address, 6, 'USDC')
  const output = new Token(1, address, 6, 'USDC')
  const onExit = jest.fn()
  const { result } = renderHook(() => useNearSwapSelection({ input, output, amount: '123' }, onExit))
  act(() => result.current.setRecipient(address))
  act(() => {
    if (action === 'select') result.current.select(Field.INPUT, output)
    else result.current.switchTokens()
  })
  expect(mockUpdateState).toHaveBeenCalledWith({
    inputCurrencyAmount: null,
    outputCurrencyAmount: null,
    orderKind: OrderKind.SELL,
    recipient: null,
    recipientAddress: null,
  })
  expect(mockNavigate).toHaveBeenCalledWith(1, expect.any(Object), {
    targetChainId: action === 'select' ? 1 : 143,
    kind: OrderKind.SELL,
    amount: '',
    clearRecipient: true,
  })
  expect(onExit).toHaveBeenCalledTimes(1)
})
