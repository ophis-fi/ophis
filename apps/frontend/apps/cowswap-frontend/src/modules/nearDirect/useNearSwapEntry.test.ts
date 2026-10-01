import { Token } from '@cowprotocol/currency'

import { act, renderHook } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { useNearSwapEntry } from './useNearSwapEntry'

let mockStandalone = true
let mockEnabled = true
jest.mock('jotai', () => ({ useAtomValue: () => ({ data: [] }) }))
jest.mock('@cowprotocol/common-hooks', () => ({
  useFeatureFlags: () => ({ isNearIntentsBridgeProviderEnabled: mockEnabled }),
}))
jest.mock('ophis/hooks/useIsOphisSwap', () => ({ useIsOphisSwap: () => mockStandalone }))
jest.mock('modules/trade', () => ({
  useDerivedTradeState: () => ({ inputCurrencyAmount: { toExact: () => '0.123456789' } }),
}))
jest.mock('./nearDirect.atoms', () => ({ nearTokensAtom: 'tokens' }))
jest.mock('./nearSwapAssets.utils', () => ({ nearTokenPickerOptions: () => ({ tokens: [], chains: [] }) }))

it('keeps recovery available only in standalone swaps, including while paused', () => {
  const { result, rerender } = renderHook(() => useNearSwapEntry())
  expect(result.current.showRecovery).toBe(true)
  mockEnabled = false
  rerender()
  expect(result.current.showRecovery).toBe(true)
  expect(result.current.enabled).toBe(false)
  mockStandalone = false
  rerender()
  expect(result.current.showRecovery).toBe(false)
  expect(result.current.tokenOptions).toBeUndefined()
})

it('starts a newly selected external source with an empty amount', () => {
  mockStandalone = true
  mockEnabled = true
  const { result } = renderHook(() => useNearSwapEntry())
  act(() => result.current.enter(Field.INPUT, new Token(143, '0x1111111111111111111111111111111111111111', 6, 'USDC')))
  expect(result.current.selection?.amount).toBe('')
})
