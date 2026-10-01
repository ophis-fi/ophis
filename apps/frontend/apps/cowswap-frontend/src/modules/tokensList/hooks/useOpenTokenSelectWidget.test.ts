import { TokenWithLogo } from '@cowprotocol/common-const'

import { act, renderHook } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { useOpenTokenSelectWidget } from './useOpenTokenSelectWidget'

import { SelectTokenWidgetState, TokenPickerOptions } from '../state/selectTokenWidgetAtom'

let mockWidget: Partial<SelectTokenWidgetState> = {}
const mockUpdate = jest.fn((update) => {
  mockWidget = { ...mockWidget, ...update }
})
jest.mock('@cowprotocol/common-hooks', () => ({ useIsBridgingEnabled: () => true }))
jest.mock('modules/trade', () => ({ TradeType: {}, useTradeTypeInfo: () => ({ tradeType: 'swap' }) }))
jest.mock('modules/trade/hooks/useTradeTypeInfoFromUrl', () => ({ useTradeTypeInfoFromUrl: () => undefined }))
jest.mock('./useSelectTokenWidgetState', () => ({ useSelectTokenWidgetState: () => mockWidget }))
jest.mock('./useUpdateSelectTokenWidgetState', () => ({ useUpdateSelectTokenWidgetState: () => mockUpdate }))
jest.mock('./useCloseTokenSelectWidget', () => ({ useCloseTokenSelectWidget: () => jest.fn() }))

it('refreshes an already-open picker when its asynchronous token options arrive', () => {
  const empty: TokenPickerOptions = { tokens: [], chains: [], includeDefaultTokens: true }
  const loaded: TokenPickerOptions = {
    ...empty,
    tokens: [new TokenWithLogo(undefined, 143, '0x1111111111111111111111111111111111111111', 6, 'USDC')],
  }
  const { result, rerender } = renderHook(({ options }) => useOpenTokenSelectWidget(options), {
    initialProps: { options: empty },
  })
  act(() => result.current(null, Field.INPUT, undefined, jest.fn()))
  expect(mockWidget.tokenOptions).toBe(empty)
  rerender({ options: loaded })
  expect(mockWidget.open).toBe(true)
  expect(mockWidget.tokenOptions).toBe(loaded)
})
