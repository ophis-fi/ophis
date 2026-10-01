import { Token } from '@cowprotocol/currency'

import { act, renderHook } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { useNearSwapSelection } from './useNearSwapSelection'

const mockNavigate = jest.fn()
jest.mock('modules/trade', () => ({ useTradeNavigate: () => mockNavigate }))

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
