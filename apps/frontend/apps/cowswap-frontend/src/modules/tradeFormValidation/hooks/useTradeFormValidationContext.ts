import { useMemo } from 'react'

import { useCurrencyAmountBalance } from '@cowprotocol/balances-and-allowances'
import { useIsOnline } from '@cowprotocol/common-hooks'
import { getIsNativeToken } from '@cowprotocol/common-utils'
import { Nullish, OrderKind } from '@cowprotocol/cow-sdk'
import { Currency, Token } from '@cowprotocol/currency'
import {
  isTradeAllowedByTokenPolicy,
  TokenPolicyProfile,
  useIsTradeUnsupported,
  useIsXstockToken,
  useTryFindToken,
} from '@cowprotocol/tokens'
import { useGnosisSafeInfo, useIsTxBundlingSupported, useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { useHasHookBridgeProvidersEnabled } from 'entities/bridgeProvider'

import { useCurrentAccountProxy } from 'modules/accountProxy/hooks/useCurrentAccountProxy'
import { useTokensBalancesCombined } from 'modules/combinedBalances'
import { useApproveState, useGetAmountToSignApprove, useIsApprovalOrPermitRequired } from 'modules/erc20Approve'
import { useInjectedWidgetParams } from 'modules/injectedWidget'
import { RwaTokenStatus, useRwaTokenStatus } from 'modules/rwa'
import {
  TradeType,
  useDerivedTradeState,
  useIsWrapOrUnwrap,
  useIsSwapEth,
  useIsHooksTradeType,
  useWrappedToken,
  useSwapFundingAmount,
  useTradePriceImpact,
} from 'modules/trade'
import { TradeQuoteState, useTradeQuote } from 'modules/tradeQuote'

import { QuoteApiError, QuoteApiErrorCodes } from 'api/cowProtocol/errors/QuoteError'
import { useIsProviderNetworkDeprecated } from 'common/hooks/useIsProviderNetworkDeprecated'
import { useIsProviderNetworkUnsupported } from 'common/hooks/useIsProviderNetworkUnsupported'
import { useOphisNameResolution } from 'common/hooks/useOphisNameResolution'
import { getBridgeIntermediateTokenAddress } from 'common/utils/getBridgeIntermediateTokenAddress'

import { useTokenCustomTradeError } from './useTokenCustomTradeError'

import { TradeFormValidationCommonContext } from '../types'

// eslint-disable-next-line max-lines-per-function
export function useTradeFormValidationContext(): TradeFormValidationCommonContext | null {
  const { account } = useWalletInfo()
  const derivedTradeState = useDerivedTradeState()
  const fundingAmount = useSwapFundingAmount()
  const wrappingFundingAmount = useSwapFundingAmount(true)
  const tradeQuote = useTradeQuote()
  const injectedWidgetParams = useInjectedWidgetParams()
  const tradePriceImpact = useTradePriceImpact()
  const isProviderNetworkUnsupported = useIsProviderNetworkUnsupported()
  const isProviderNetworkDeprecated = useIsProviderNetworkDeprecated()
  const isOnline = useIsOnline()
  const { isLoading: isBalancesLoading, hasFirstLoad, error: balancesError } = useTokensBalancesCombined()

  const { inputCurrency, outputCurrency, recipient, tradeType } = derivedTradeState || {}
  const wrappedToken = useWrappedToken()
  const wrappedBalance = useCurrencyAmountBalance(wrappedToken)
  const isSwapEth = useIsSwapEth()
  const isHooksStore = useIsHooksTradeType()
  const customTokenError = useTokenCustomTradeError(inputCurrency, outputCurrency, tradeQuote.error)
  const amountToApprove = useGetAmountToSignApprove()
  const { state: approvalState } = useApproveState(amountToApprove)
  const recipientChainId = outputCurrency?.chainId || inputCurrency?.chainId
  const { address: recipientEnsAddress } = useOphisNameResolution(recipient, recipientChainId)
  const isSwapUnsupported =
    useIsTradeUnsupported(inputCurrency, outputCurrency) || isUnsupportedTokenInQuote(tradeQuote)
  const isTokenPolicyDenied = getIsTokenPolicyDenied(inputCurrency, outputCurrency)
  const isInputCurrencyXstock = useIsXstockToken(getNonNativeCurrency(inputCurrency))
  const isOutputCurrencyXstock = useIsXstockToken(getNonNativeCurrency(outputCurrency))

  const isBundlingSupported = useIsTxBundlingSupported()
  const isNativeWrapFlow = [isSwapEth, !isBundlingSupported, !isHooksStore].every(Boolean)
  const isWrapUnwrap = useIsWrapOrUnwrap()
  const { isSupportedWallet } = useWalletDetails()
  const gnosisSafeInfo = useGnosisSafeInfo()
  const hasHookBridgeProvidersEnabled = useHasHookBridgeProvidersEnabled()
  const { isLoading, data: proxyAccount } = useCurrentAccountProxy()
  const isAccountProxyLoading = hasHookBridgeProvidersEnabled ? isLoading : false
  const isProxySetupValid = hasHookBridgeProvidersEnabled ? !!proxyAccount?.isProxySetupValid : true

  const isSafeReadonlyUser = gnosisSafeInfo?.isReadOnly === true

  const isApproveRequired = useIsApprovalOrPermitRequired({
    isBundlingSupportedOrEnabledForContext: isBundlingSupported,
  }).reason

  const isInsufficientBalanceOrderAllowed = tradeType === TradeType.LIMIT_ORDER

  const { token: intermediateBuyToken, toBeImported } = useTryFindToken(
    getBridgeIntermediateTokenAddress(tradeQuote.bridgeQuote),
  )

  const { status: rwaStatus } = useRwaTokenStatus({
    inputCurrency,
    outputCurrency,
  })
  const isRestrictedForCountry = rwaStatus === RwaTokenStatus.Restricted

  return useMemo(() => {
    if (!derivedTradeState) return null
    const useWrappedBalance =
      fundingAmount &&
      wrappedBalance &&
      [
        isNativeWrapFlow,
        derivedTradeState.orderKind === OrderKind.BUY,
        wrappedBalance.currency.chainId === fundingAmount.currency.chainId,
        !wrappedBalance.lessThan(fundingAmount),
      ].every(Boolean)

    return {
      account,
      isWrapUnwrap,
      isBundlingSupported,
      isSupportedWallet,
      isSwapUnsupported,
      isTokenPolicyDenied,
      isSafeReadonlyUser,
      recipientEnsAddress,
      approvalState,
      tradeQuote,
      isApproveRequired,
      isInsufficientBalanceOrderAllowed,
      isProviderNetworkUnsupported,
      isProviderNetworkDeprecated,
      isOnline,
      derivedTradeState: {
        ...derivedTradeState,
        inputCurrencyAmount: isNativeWrapFlow && !useWrappedBalance ? wrappingFundingAmount : fundingAmount,
        inputCurrencyBalance: useWrappedBalance ? wrappedBalance : derivedTradeState.inputCurrencyBalance,
      },
      intermediateTokenToBeImported: !!intermediateBuyToken && toBeImported,
      isAccountProxyLoading,
      isProxySetupValid,
      customTokenError,
      isRestrictedForCountry,
      isBalancesLoading: !hasFirstLoad || isBalancesLoading,
      balancesError,
      injectedWidgetParams,
      tradePriceImpact,
      isInputCurrencyXstock,
      isOutputCurrencyXstock,
    }
  }, [
    hasFirstLoad,
    account,
    approvalState,
    customTokenError,
    derivedTradeState,
    fundingAmount,
    wrappingFundingAmount,
    wrappedBalance,
    isNativeWrapFlow,
    intermediateBuyToken,
    isAccountProxyLoading,
    isApproveRequired,
    isBundlingSupported,
    isInsufficientBalanceOrderAllowed,
    isOnline,
    isProviderNetworkUnsupported,
    isProviderNetworkDeprecated,
    isRestrictedForCountry,
    isSafeReadonlyUser,
    isSupportedWallet,
    isBalancesLoading,
    isSwapUnsupported,
    isTokenPolicyDenied,
    isWrapUnwrap,
    isProxySetupValid,
    isInputCurrencyXstock,
    isOutputCurrencyXstock,
    recipientEnsAddress,
    toBeImported,
    tradeQuote,
    balancesError,
    injectedWidgetParams,
    tradePriceImpact,
  ])
}

function isUnsupportedTokenInQuote(state: TradeQuoteState): boolean {
  return state.error instanceof QuoteApiError && state.error?.type === QuoteApiErrorCodes.UnsupportedToken
}

function getNonNativeCurrency(currency: Nullish<Currency>): Token | null {
  if (!currency || getIsNativeToken(currency) || !('address' in currency)) {
    return null
  }

  return currency
}

function getIsTokenPolicyDenied(inputCurrency: Nullish<Currency>, outputCurrency: Nullish<Currency>): boolean {
  if (!inputCurrency || !outputCurrency) return false

  return !isTradeAllowedByTokenPolicy(inputCurrency, outputCurrency, TokenPolicyProfile.ESTABLISHED_SETTLEMENT)
}
