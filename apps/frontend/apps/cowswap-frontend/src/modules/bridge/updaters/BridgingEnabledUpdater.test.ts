import { useSetIsBridgingEnabled } from '@cowprotocol/common-hooks'

import { renderHook } from '@testing-library/react'
import { useIsCctpEnabled } from 'entities/cctp'

import { useInjectedWidgetParams } from 'modules/injectedWidget'

import { BridgingEnabledUpdater } from './BridgingEnabledUpdater'

jest.mock('entities/cctp/useIsCctpEnabled', () => ({ useIsCctpEnabled: jest.fn(() => true) }))

jest.mock('@cowprotocol/common-hooks', () => ({
  useFeatureFlags: () => ({}),
  useSetIsBridgingEnabled: jest.fn(),
}))
jest.mock('@cowprotocol/common-utils', () => ({ isInjectedWidget: () => true }))
jest.mock('@cowprotocol/wallet', () => ({ useIsSafeApp: () => false }))
jest.mock('entities/bridgeProvider', () => ({ useHasBridgeProviders: () => false }))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
jest.mock('modules/trade', () => ({ useTradeTypeInfo: () => ({ route: '/swap' }) }))
jest.mock('common/constants/routes', () => ({ Routes: { SWAP: '/swap', HOOKS: '/hooks' } }))
jest.mock('modules/injectedWidget', () => ({ useInjectedWidgetParams: jest.fn(() => ({})) }))

it('keeps CCTP available without generic providers while respecting the widget kill switch', () => {
  const setEnabled = jest.fn()
  jest.mocked(useSetIsBridgingEnabled).mockReturnValue(setEnabled)
  const { rerender } = renderHook(() => BridgingEnabledUpdater())
  expect(setEnabled).toHaveBeenLastCalledWith(true)
  jest.mocked(useInjectedWidgetParams).mockReturnValue({ disableCrossChainSwap: true })
  rerender()
  expect(setEnabled).toHaveBeenLastCalledWith(false)
})

it('does not enable bridging from CCTP alone on an unsupported surface', () => {
  jest.mocked(useIsCctpEnabled).mockReturnValue(false)
  jest.mocked(useInjectedWidgetParams).mockReturnValue({})
  const setEnabled = jest.fn()
  jest.mocked(useSetIsBridgingEnabled).mockReturnValue(setEnabled)
  renderHook(() => BridgingEnabledUpdater())
  expect(setEnabled).toHaveBeenLastCalledWith(false)
})
