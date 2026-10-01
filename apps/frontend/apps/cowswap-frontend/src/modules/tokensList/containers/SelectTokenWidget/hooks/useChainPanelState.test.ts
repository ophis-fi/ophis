import { renderHook } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { useChainPanelState } from './useChainPanelState'

let mockExternalOptions = false
jest.mock('@cowprotocol/common-hooks', () => ({ useIsBridgingEnabled: () => true }))
jest.mock('@cowprotocol/wallet', () => ({ useIsSmartContractWallet: () => true }))
jest.mock('modules/trade', () => ({ TradeType: { YIELD: 'yield' } }))
jest.mock('../../../hooks/useChainsToSelect', () => ({ useChainsToSelect: () => ({ chains: [{ id: 1 }] }) }))
jest.mock('../../../hooks/useOnSelectChain', () => ({ useOnSelectChain: () => jest.fn() }))
jest.mock('../../../hooks/useSelectTokenWidgetState', () => ({
  useSelectTokenWidgetState: () => ({ tokenOptions: mockExternalOptions ? { chains: [], tokens: [] } : undefined }),
}))

it('allows external source selection for a smart wallet while retaining the standard restriction', () => {
  const { result, rerender } = renderHook(() => useChainPanelState(undefined, Field.INPUT))
  expect(result.current.isEnabled).toBe(false)
  mockExternalOptions = true
  rerender()
  expect(result.current.isEnabled).toBe(true)
})
