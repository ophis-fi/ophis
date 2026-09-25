import { useAtomValue } from 'jotai'
import { useEffect, useMemo } from 'react'

import { isBridgeOnlyDestinationChain } from '@cowprotocol/common-const'
import { getCurrencyAddress, isSupportedChainId } from '@cowprotocol/common-utils'
import { getAddressKey, isAdditionalTargetChain } from '@cowprotocol/cow-sdk'
import { BuyTokensParams } from '@cowprotocol/sdk-bridging'

import { useBridgeSupportedNetworks, useBridgeSupportedTokens } from 'entities/bridgeProvider'
import { useLocation } from 'react-router'

import {
  useTradeTypeInfo,
  useTradeTypeInfoFromUrl,
  parameterizeTradeRoute,
  parameterizeTradeSearch,
} from 'modules/trade'

import type { RoutesValues } from 'common/constants/routes'
import { useNavigate } from 'common/hooks/useNavigate'

import { getInvalidBridgeOutputPatch, getUnsupportedBridgePairPatch } from './InvalidBridgeOutputUpdater.utils'

import { useSwapDerivedState } from '../hooks/useSwapDerivedState'
import { useUpdateSwapRawState } from '../hooks/useUpdateSwapRawState'
import { swapRawStateAtom, SwapRawState } from '../state/swapRawStateAtom'

function syncUrlAfterPatch(params: {
  patch: Partial<SwapRawState>
  tradeRoute: RoutesValues | undefined
  rawState: SwapRawState
  pathname: string
  search: string
  navigate: ReturnType<typeof useNavigate>
}): void {
  const { patch, tradeRoute, rawState, pathname, search, navigate } = params
  const shouldSyncUrl =
    ('outputCurrencyId' in patch && patch.outputCurrencyId === null) ||
    ('targetChainId' in patch && patch.targetChainId === null)

  if (!shouldSyncUrl || !tradeRoute) return

  const nextState = { ...rawState, ...patch }
  const nextPathname = parameterizeTradeRoute(
    {
      chainId: nextState.chainId ? nextState.chainId.toString() : undefined,
      inputCurrencyId: nextState.inputCurrencyId ?? undefined,
      outputCurrencyId: nextState.outputCurrencyId ?? undefined,
      inputCurrencyAmount: undefined,
      outputCurrencyAmount: undefined,
      orderKind: undefined,
    },
    tradeRoute,
  )
  const nextTargetChainId = nextState.targetChainId ?? undefined
  const nextSearch = parameterizeTradeSearch(
    search,
    nextTargetChainId ? { targetChainId: nextTargetChainId } : undefined,
  )

  if (pathname === nextPathname && search.slice(1) === nextSearch) return

  navigate({ pathname: nextPathname, search: nextSearch }, { replace: true })
}

export function InvalidBridgeOutputUpdater(): null {
  const rawState = useAtomValue(swapRawStateAtom)
  const { inputCurrency } = useSwapDerivedState()
  const updateSwapState = useUpdateSwapRawState()
  const navigate = useNavigate()
  const location = useLocation()
  const tradeTypeInfoFromState = useTradeTypeInfo()
  const tradeTypeInfoFromUrl = useTradeTypeInfoFromUrl()
  const tradeTypeInfo = tradeTypeInfoFromState ?? tradeTypeInfoFromUrl
  const tradeRoute = tradeTypeInfo?.route

  const rawChainId = rawState.chainId ?? undefined
  const rawTargetChainId = rawState.targetChainId ?? undefined
  const sourceChainId = isSupportedChainId(rawChainId) ? rawChainId : undefined
  const isValidTargetChain =
    rawTargetChainId !== undefined &&
    (isSupportedChainId(rawTargetChainId) ||
      isAdditionalTargetChain(rawTargetChainId) ||
      // Bridge-only destinations (Monad, X Layer) are valid targets too, so a
      // persisted trade to them is validated and reset like any other.
      isBridgeOnlyDestinationChain(rawTargetChainId))
  const targetChainId = isValidTargetChain ? rawTargetChainId : undefined

  const { data: bridgeSupportedNetworks, isLoading: isBridgeSupportedNetworksLoading } = useBridgeSupportedNetworks()

  const unsupportedBridgePairPatch = useMemo(
    () =>
      getUnsupportedBridgePairPatch({
        sourceChainId,
        targetChainId,
        bridgeSupportedNetworks,
        isBridgeSupportedNetworksLoading,
      }),
    [sourceChainId, targetChainId, bridgeSupportedNetworks, isBridgeSupportedNetworksLoading],
  )

  const bridgeRouteParams: BuyTokensParams | undefined = useMemo(() => {
    if (unsupportedBridgePairPatch) {
      return undefined
    }

    if (!sourceChainId || !targetChainId || sourceChainId === targetChainId || !inputCurrency) {
      return undefined
    }

    // Derived currencies can lag URL edits by one render. Never validate a new
    // route using the previous route's source token.
    if (
      inputCurrency.chainId !== sourceChainId ||
      ![getCurrencyAddress(inputCurrency), inputCurrency.symbol].some(
        (id) => id && rawState.inputCurrencyId && getAddressKey(id) === getAddressKey(rawState.inputCurrencyId),
      )
    )
      return undefined
    return {
      sellChainId: sourceChainId,
      buyChainId: targetChainId,
      sellTokenAddress: getCurrencyAddress(inputCurrency),
    }
  }, [sourceChainId, targetChainId, unsupportedBridgePairPatch, inputCurrency, rawState.inputCurrencyId])

  const { data: bridgeRouteData, isLoading: isBridgeRouteLoading } = useBridgeSupportedTokens(bridgeRouteParams)

  const patch = useMemo(() => {
    return (
      unsupportedBridgePairPatch ??
      getInvalidBridgeOutputPatch({
        sourceChainId,
        targetChainId,
        selectedOutputCurrencyId: rawState.outputCurrencyId,
        bridgeRouteData,
        isBridgeRouteLoading,
      })
    )
  }, [
    sourceChainId,
    targetChainId,
    rawState.outputCurrencyId,
    bridgeRouteData,
    isBridgeRouteLoading,
    unsupportedBridgePairPatch,
  ])

  useEffect(() => {
    if (!patch) return

    updateSwapState(patch)
    syncUrlAfterPatch({
      patch,
      tradeRoute,
      rawState,
      pathname: location.pathname,
      search: location.search,
      navigate,
    })
  }, [patch, updateSwapState, tradeRoute, rawState, location.pathname, location.search, navigate])

  return null
}
