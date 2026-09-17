import { OrderKind } from '@cowprotocol/cow-sdk'

import { useSwitchTokensPlaces } from 'modules/trade'

import { useSwapDerivedState } from './useSwapDerivedState'

export function useOnSwitchTokens(): () => void {
  const { orderKind } = useSwapDerivedState()
  return useSwitchTokensPlaces({ orderKind: orderKind === OrderKind.SELL ? OrderKind.BUY : OrderKind.SELL })
}
