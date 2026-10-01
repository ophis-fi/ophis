import { OrderKind } from '@cowprotocol/cow-sdk'
import { Token } from '@cowprotocol/currency'

import { act, renderHook } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { useNearSwapSelection } from './useNearSwapSelection'

import fixture from '../fixtures/monadDeposit.json'
import { nearTransferSchema } from '../nearDirect.schemas'

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
    targetChainId: 143,
    kind: OrderKind.SELL,
    amount: '',
    clearRecipient: true,
  })
  expect(onExit).toHaveBeenCalledTimes(1)
})

it.each([Field.INPUT, Field.OUTPUT])('reverses the pair when selecting the opposite token in %s', (field) => {
  const address = '0x1111111111111111111111111111111111111111'
  const input = new Token(143, address, 6, 'USDC')
  const output = new Token(196, address, 6, 'USDC')
  const { result } = renderHook(() => useNearSwapSelection({ input, output, amount: '123' }, jest.fn()))
  act(() => {
    result.current.setRecipient(address)
    result.current.setRefundTo(address)
  })
  act(() => result.current.select(field, field === Field.INPUT ? output : input))
  expect(result.current.selection).toEqual({ input: output, output: input, amount: '' })
  expect(result.current.recipient).toBe('')
  expect(result.current.refundTo).toBe('')
})

it('returns to standard swap when selecting the direct source as the destination reverses into a supported source', () => {
  const address = '0x1111111111111111111111111111111111111111'
  const input = new Token(143, address, 6, 'USDC')
  const output = new Token(8453, address, 6, 'USDC')
  const onExit = jest.fn()
  const { result } = renderHook(() => useNearSwapSelection({ input, output, amount: '123' }, onExit))
  act(() => result.current.select(Field.OUTPUT, input))
  expect(mockNavigate).toHaveBeenCalledWith(
    8453,
    { inputCurrencyId: output.address, outputCurrencyId: input.address },
    { targetChainId: 143, kind: OrderKind.SELL, amount: '', clearRecipient: true },
  )
  expect(onExit).toHaveBeenCalledTimes(1)
})

it.each(['busy', 'preview'])('keeps the reviewed pair unchanged while %s', (guard) => {
  const input = new Token(143, fixture.source.contractAddress, 6, 'USDC')
  const output = new Token(1, fixture.destination.contractAddress, 6, 'USDC')
  const initial = { input, output, amount: '123' }
  const onExit = jest.fn()
  const { result } = renderHook(() => useNearSwapSelection(initial, onExit))
  act(() => {
    if (guard === 'busy') result.current.setBusy(true)
    else result.current.setPreview(nearTransferSchema.parse(fixture))
  })
  act(() => {
    result.current.select(Field.INPUT, output)
    result.current.switchTokens()
  })
  expect(result.current.selection).toEqual(initial)
  expect(mockNavigate).not.toHaveBeenCalled()
  expect(onExit).not.toHaveBeenCalled()
})
