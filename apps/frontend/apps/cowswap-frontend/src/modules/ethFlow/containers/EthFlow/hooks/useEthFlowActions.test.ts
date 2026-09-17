import { OrderKind } from '@cowprotocol/cow-sdk'

import { renderHook } from '@testing-library/react'

import { useDerivedTradeState, useOnCurrencySelection, useTradeConfirmActions } from 'modules/trade'
import { useTradeQuoteManager } from 'modules/tradeQuote'

import { EthFlowActionCallbacks, useEthFlowActions } from './useEthFlowActions'

jest.mock('modules/tradeQuote', () => ({ useTradeQuoteManager: jest.fn() }))
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ chainId: 1 }) }))
jest.mock('modules/trade', () => ({
  useDerivedTradeState: jest.fn(),
  useOnCurrencySelection: jest.fn(),
  useTradeConfirmActions: jest.fn(),
}))
jest.mock('modules/swap/hooks/useSwapSettings', () => ({ useSwapPartialApprovalToggleState: () => [true] }))

it.each([OrderKind.BUY, OrderKind.SELL])(
  'continues %s with WETH and requires a fresh BUY review',
  async (orderKind) => {
    const onOpen = jest.fn()
    const reset = jest.fn()
    jest.mocked(useTradeQuoteManager).mockReturnValue({ reset } as ReturnType<typeof useTradeQuoteManager>)
    const selectCurrency = jest.fn((_field, _currency, callback) => callback())
    jest.mocked(useDerivedTradeState).mockReturnValue({ orderKind } as ReturnType<typeof useDerivedTradeState>)
    jest.mocked(useOnCurrencySelection).mockReturnValue(selectCurrency)
    jest.mocked(useTradeConfirmActions).mockReturnValue({ onOpen } as ReturnType<typeof useTradeConfirmActions>)
    const callbacks: EthFlowActionCallbacks = {
      approve: jest.fn(),
      wrap: jest.fn(),
      directSwap: jest.fn(),
      dismiss: jest.fn(),
    }
    const { result } = renderHook(() => useEthFlowActions(callbacks))
    await result.current.swap()
    expect(reset).toHaveBeenCalledTimes(orderKind === OrderKind.BUY ? 1 : 0)
    expect(callbacks.dismiss).toHaveBeenCalledTimes(1)
    expect(selectCurrency.mock.calls[0][1].address.toLowerCase()).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
    expect(onOpen).toHaveBeenCalledTimes(orderKind === OrderKind.BUY ? 0 : 1)
    expect(callbacks.directSwap).not.toHaveBeenCalled()
  },
)
