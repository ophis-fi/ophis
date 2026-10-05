import { useCallback } from 'react'

import { BRIDGE_SOURCE_CHAIN_IDS } from '@cowprotocol/common-const'
import { getCurrencyAddress, isSupportedChainId } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'

import { hasCctpRoute, useIsCctpEnabled } from 'entities/cctp'

import { useSwitchTokensPlaces, useTradeNavigate } from 'modules/trade'

import { useSwapDerivedState } from './useSwapDerivedState'
import { useUpdateSwapRawState } from './useUpdateSwapRawState'

export function useOnSwitchTokens(): () => boolean {
  const cctpEnabled = useIsCctpEnabled()
  const { inputCurrency, outputCurrency, orderKind } = useSwapDerivedState()
  const switchSameChainTokens = useSwitchTokensPlaces({
    orderKind: orderKind === OrderKind.SELL ? OrderKind.BUY : OrderKind.SELL,
  })
  const navigate = useTradeNavigate()
  const updateState = useUpdateSwapRawState()

  return useCallback(() => {
    if (!inputCurrency || !outputCurrency || inputCurrency.chainId === outputCurrency.chainId) {
      switchSameChainTokens()
      return true
    }
    if (!isSupportedChainId(outputCurrency.chainId)) return false
    const isSourceSupported =
      BRIDGE_SOURCE_CHAIN_IDS.has(outputCurrency.chainId) ||
      (cctpEnabled && hasCctpRoute(outputCurrency.chainId, inputCurrency.chainId))
    if (!isSourceSupported) return false

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
    return true
  }, [inputCurrency, outputCurrency, switchSameChainTokens, cctpEnabled, navigate, updateState])
}
