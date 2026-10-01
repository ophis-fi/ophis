import { Token } from '@cowprotocol/currency'

import { act, renderHook } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { useNearSwapEntry } from './useNearSwapEntry'

let mockStandalone = true
let mockEnabled = true
const mockRead = jest.fn((_value: unknown): { data?: unknown[]; error?: Error; refetch?: () => void } => ({ data: [] }))
jest.mock('jotai', () => ({ ...jest.requireActual('jotai'), useAtomValue: (value: unknown) => mockRead(value) }))
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

it.each([
  [true, false],
  [false, true],
])('does not subscribe to the external query when standalone=%s enabled=%s', (standalone, enabled) => {
  mockStandalone = standalone
  mockEnabled = enabled
  mockRead.mockClear()
  renderHook(() => useNearSwapEntry())
  expect(mockRead).not.toHaveBeenCalledWith('tokens')
})

it('keeps picker options stable while the asset query is pending or failed', () => {
  mockStandalone = true
  mockEnabled = true
  mockRead.mockReturnValue({ data: undefined })
  const { result, rerender } = renderHook(() => useNearSwapEntry())
  const options = result.current.tokenOptions
  rerender()
  expect(result.current.tokenOptions).toBe(options)
})

it('exposes a retryable asset failure before any direct swap is selected', () => {
  mockStandalone = true
  mockEnabled = true
  const refetch = jest.fn()
  mockRead.mockReturnValue({ error: new Error('unavailable'), refetch })
  const { result } = renderHook(() => useNearSwapEntry())
  expect(result.current.selection).toBeNull()
  expect(result.current.tokenError).toBe(true)
  act(() => result.current.retryTokens())
  expect(refetch).toHaveBeenCalledTimes(1)
})
