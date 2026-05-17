import { useMemo } from 'react'

import { WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { doesTokenMatchSymbolOrAddress } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useTradeState } from './useTradeState'

function getIsWrappedNativeToken(chainId: SupportedChainId, tokenId: string): boolean {
  const nativeToken = WRAPPED_NATIVE_CURRENCIES[chainId]
  // 2026-05-17 Codex-Cyber finding: WRAPPED_NATIVE_CURRENCIES[chainId] is
  // undefined for any chain outside SupportedChainId (the user's wallet is
  // on Polygon, BSC, etc.), and the downstream `doesTokenMatchSymbolOrAddress`
  // dereferences `.address` unconditionally — would crash every trade route.
  // No wrapped-native to match against on an unsupported chain → just false.
  if (!nativeToken) return false

  return doesTokenMatchSymbolOrAddress(nativeToken, tokenId)
}

export function useIsWrappedIn(): boolean {
  const { chainId } = useWalletInfo()
  const { state } = useTradeState()
  const { inputCurrencyId } = state || {}

  return useMemo(
    () => Boolean(chainId && inputCurrencyId && getIsWrappedNativeToken(chainId, inputCurrencyId)),
    [chainId, inputCurrencyId],
  )
}
export function useIsWrappedOut(): boolean {
  const { chainId } = useWalletInfo()
  const { state } = useTradeState()
  const { outputCurrencyId } = state || {}

  return useMemo(
    () => Boolean(chainId && outputCurrencyId && getIsWrappedNativeToken(chainId, outputCurrencyId)),
    [chainId, outputCurrencyId],
  )
}
