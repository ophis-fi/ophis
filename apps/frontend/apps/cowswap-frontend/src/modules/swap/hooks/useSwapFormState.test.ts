import { NATIVE_CURRENCIES, USDC_MAINNET } from '@cowprotocol/common-const'
import { OrderKind } from '@cowprotocol/cow-sdk'

import { renderHook } from '@testing-library/react'

import { useSwapDerivedState } from './useSwapDerivedState'
import { SwapFormState, useSwapFormState } from './useSwapFormState'

jest.mock('@cowprotocol/wallet', () => ({
  useIsSmartContractWallet: () => false,
  useIsTxBundlingSupported: () => false,
}))
jest.mock('modules/trade', () => ({ useIsHooksTradeType: () => false }))
jest.mock('./useSwapDerivedState', () => ({ useSwapDerivedState: jest.fn() }))

it.each([
  [OrderKind.BUY, SwapFormState.SwapWithWrappedToken],
  [OrderKind.SELL, SwapFormState.RegularEthFlowSwap],
])('routes EOA native %s to %s', (orderKind, expected) => {
  jest
    .mocked(useSwapDerivedState)
    .mockReturnValue({ inputCurrency: NATIVE_CURRENCIES[1], outputCurrency: USDC_MAINNET, orderKind } as ReturnType<
      typeof useSwapDerivedState
    >)
  const { result } = renderHook(() => useSwapFormState())
  expect(result.current).toBe(expected)
})
