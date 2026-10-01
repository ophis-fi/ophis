import { useCallback } from 'react'

import { getCurrencyAddress, isSupportedChainId } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'

import { useSwitchTokensPlaces, useTradeNavigate } from 'modules/trade'

import { useSwapDerivedState } from './useSwapDerivedState'
import { useUpdateSwapRawState } from './useUpdateSwapRawState'

export function useOnSwitchTokens(): () => void {
  const { inputCurrency, outputCurrency, orderKind } = useSwapDerivedState()
  const switchSameChainTokens = useSwitchTokensPlaces({
    orderKind: orderKind === OrderKind.SELL ? OrderKind.BUY : OrderKind.SELL,
  })
  const navigate = useTradeNavigate()
  const updateState = useUpdateSwapRawState()

  return useCallback(() => {
    if (!inputCurrency || !outputCurrency || inputCurrency.chainId === outputCurrency.chainId) {
      switchSameChainTokens()
      return
    }
    if (!isSupportedChainId(outputCurrency.chainId)) return

    updateState({
      inputCurrencyAmount: null,
      outputCurrencyAmount: null,
      orderKind: OrderKind.SELL,
      recipient: null,
      recipientAddress: null,
    })
    void navigate(
      outputCurrency.chainId,
      { inputCurrencyId: getCurrencyAddress(outputCurrency), outputCurrencyId: getCurrencyAddress(inputCurrency) },
      { targetChainId: inputCurrency.chainId, kind: OrderKind.SELL, amount: '', clearRecipient: true },
    )
  }, [inputCurrency, outputCurrency, switchSameChainTokens, navigate, updateState])
}
