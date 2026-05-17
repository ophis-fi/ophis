import React, { ReactNode, useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { useIsSafeWallet } from '@cowprotocol/wallet'

import { AddIntermediateToken } from 'modules/tokensList'
import {
  useConfirmTradeWithRwaCheck,
  useGetConfirmButtonLabel,
  useIsCurrentTradeBridging,
  useIsNoImpactWarningAccepted,
  useWrappedToken,
} from 'modules/trade'
import {
  TradeFormButtons,
  TradeFormValidation,
  useGetTradeFormValidation,
  useIsTradeFormValidationPassed,
  useTradeFormButtonContext,
} from 'modules/tradeFormValidation'
import { useHighFeeWarning } from 'modules/tradeWidgetAddons'

import { useSafeMemoObject } from 'common/hooks/useSafeMemo'

import { swapTradeButtonsMap } from './swapTradeButtonsMap'

import { useOnCurrencySelection } from '../../hooks/useOnCurrencySelection'
import {
  useShouldCheckBridgingRecipient,
  useSmartContractRecipientConfirmed,
} from '../../hooks/useSmartContractRecipientConfirmed'
import { buildSwapBridgeClickEvent, useSwapBridgeClickEventData } from '../../hooks/useSwapBridgeClickEvent'
import { useSwapDerivedState } from '../../hooks/useSwapDerivedState'
import { useSwapFormState } from '../../hooks/useSwapFormState'

interface TradeButtonsProps {
  isTradeContextReady: boolean

  openNativeWrapModal(): void

  hasEnoughWrappedBalanceForSwap: boolean
  tokenToBeImported: boolean
  intermediateBuyToken: TokenWithLogo | null
  setShowAddIntermediateTokenModal: (show: boolean) => void
}

export function TradeButtons({
  isTradeContextReady,
  openNativeWrapModal,
  hasEnoughWrappedBalanceForSwap,
  tokenToBeImported,
  intermediateBuyToken,
  setShowAddIntermediateTokenModal,
}: TradeButtonsProps): ReactNode {
  const { inputCurrency } = useSwapDerivedState()

  const primaryFormValidation = useGetTradeFormValidation()
  const isPrimaryValidationPassed = useIsTradeFormValidationPassed()
  const { feeWarningAccepted } = useHighFeeWarning()
  const isNoImpactWarningAccepted = useIsNoImpactWarningAccepted()
  const localFormValidation = useSwapFormState()
  const wrappedToken = useWrappedToken()
  const onCurrencySelection = useOnCurrencySelection()
  const isCurrentTradeBridging = useIsCurrentTradeBridging()
  const shouldCheckBridgingRecipient = useShouldCheckBridgingRecipient()
  const smartContractRecipientConfirmed = useSmartContractRecipientConfirmed()
  const isSafeWallet = useIsSafeWallet()

  const { confirmTrade } = useConfirmTradeWithRwaCheck()

  const confirmText = useGetConfirmButtonLabel('swap', isCurrentTradeBridging)

  const swapBridgeClickEventData = useSwapBridgeClickEventData()
  const swapBridgeClickEvent = useMemo(
    () => buildSwapBridgeClickEvent({ ...swapBridgeClickEventData, action: 'swap_bridge_click' }),
    [swapBridgeClickEventData],
  )
  const swapBridgeClickApproveEvent = useMemo(
    () => buildSwapBridgeClickEvent({ ...swapBridgeClickEventData, action: 'swap_bridge_click_approve' }),
    [swapBridgeClickEventData],
  )

  const tradeFormAnalytics = useSafeMemoObject({
    confirmClickEvent: swapBridgeClickEvent,
    approveClickEvent: swapBridgeClickApproveEvent,
  })

  // enable partial approve only for swap
  const tradeFormButtonContext = useTradeFormButtonContext(confirmText, confirmTrade, true, tradeFormAnalytics)

  const context = useSafeMemoObject({
    wrappedToken,
    onEthFlow: openNativeWrapModal,
    openSwapConfirm: confirmTrade,
    inputCurrency,
    hasEnoughWrappedBalanceForSwap,
    onCurrencySelection,
    confirmText,
    isSafeWallet,
    isCurrentTradeBridging,
    swapBridgeClickEvent,
  })

  const shouldShowAddIntermediateToken =
    tokenToBeImported &&
    !!intermediateBuyToken &&
    primaryFormValidation === TradeFormValidation.ImportingIntermediateToken

  const isDisabled =
    !isTradeContextReady ||
    !feeWarningAccepted ||
    !isNoImpactWarningAccepted ||
    (shouldCheckBridgingRecipient ? !smartContractRecipientConfirmed : false)

  if (!tradeFormButtonContext) return null

  if (localFormValidation && isPrimaryValidationPassed) {
    // 2026-05-17 hardening: wrappedToken is undefined on unsupported wallet
    // chains. The swap-flow button-map can't be entered without it; render
    // the default trade-form path instead (which surfaces a "wrong network"
    // primaryFormValidation error to the user).
    if (!context.wrappedToken) return null
    return swapTradeButtonsMap[localFormValidation](
      { ...context, wrappedToken: context.wrappedToken },
      isDisabled,
    )
  }

  return (
    <>
      <TradeFormButtons
        confirmText={confirmText}
        validation={primaryFormValidation}
        context={tradeFormButtonContext}
        isDisabled={isDisabled}
      />
      {shouldShowAddIntermediateToken && (
        <AddIntermediateToken
          intermediateBuyToken={intermediateBuyToken!}
          onImport={() => setShowAddIntermediateTokenModal(true)}
        />
      )}
    </>
  )
}
