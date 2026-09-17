import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { getIsNativeToken, isSellOrder } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useTryFindToken } from '@cowprotocol/tokens'
import { InlineBanner, StatusColorVariant, LinkStyledButton } from '@cowprotocol/ui'
import { useIsEagerConnectInProgress, useIsSmartContractWallet, useWalletInfo } from '@cowprotocol/wallet'

import { t } from '@lingui/core/macro'

import { Field } from 'legacy/state/types'
import { useHooksEnabledManager } from 'legacy/state/user/hooks'

import { TradeApproveWithAffectedOrderList } from 'modules/erc20Approve'
import { EthFlowModal, EthFlowProps } from 'modules/ethFlow'
import { AddIntermediateTokenModal } from 'modules/tokensList'
import {
  TradeWidget,
  TradeWidgetSlots,
  useGetReceiveAmountInfo,
  useSwapFundingAmount,
  useTradePriceImpact,
  useWrapNativeFlow,
} from 'modules/trade'
import { useHandleSwap } from 'modules/tradeFlow'
import { useIsTradeFormValidationPassed, useShouldHideTradeRateDetails } from 'modules/tradeFormValidation'
import { useTradeQuote } from 'modules/tradeQuote'
import { SettingsTab } from 'modules/tradeWidgetAddons'
import { useUsdAmount } from 'modules/usdAmount'

import { useIsProviderNetworkDeprecated } from 'common/hooks/useIsProviderNetworkDeprecated'
import { useIsProviderNetworkUnsupported } from 'common/hooks/useIsProviderNetworkUnsupported'
import { useRateInfoParams } from 'common/hooks/useRateInfoParams'
import { useSafeMemoObject } from 'common/hooks/useSafeMemo'
import { CurrencyInfo } from 'common/pure/CurrencyInputPanel/types'
import { getBridgeIntermediateTokenAddress } from 'common/utils/getBridgeIntermediateTokenAddress'

import { Container } from './styled'

import { useHasEnoughWrappedBalanceForSwap } from '../../hooks/useHasEnoughWrappedBalanceForSwap'
import { useSwapDerivedState } from '../../hooks/useSwapDerivedState'
import {
  useSwapDeadlineState,
  useSwapPartialApprovalToggleState,
  useSwapRecipientToggleState,
  useSwapSettings,
} from '../../hooks/useSwapSettings'
import { useSwapWidgetActions } from '../../hooks/useSwapWidgetActions'
import { useUpdateSwapRawState } from '../../hooks/useUpdateSwapRawState'
import { useWholeTokenRoute } from '../../hooks/useWholeTokenRoute'
import { CrossChainUnlockScreen } from '../../pure/CrossChainUnlockScreen'
import { BottomBanners } from '../BottomBanners/BottomBanners.container'
import { SwapConfirmModal } from '../SwapConfirmModal'
import { SwapRateDetails } from '../SwapRateDetails'
import { TradeButtons } from '../TradeButtons'
import { Warnings } from '../Warnings'
import { WholeTokenReview } from '../WholeTokenRoute/WholeTokenReview.container'
import { WholeTokenRoute } from '../WholeTokenRoute/WholeTokenRoute.container'

export interface SwapWidgetProps {
  headerContent?: ReactNode
  topContent?: ReactNode
  bottomContent?: ReactNode
  allowSwapSameToken?: boolean
}

// TODO: Break down this large function into smaller functions
// eslint-disable-next-line max-lines-per-function
export function SwapWidget({
  headerContent,
  topContent,
  bottomContent,
  allowSwapSameToken,
}: SwapWidgetProps): ReactNode {
  const direct = useWholeTokenRoute()
  const { showRecipient } = useSwapSettings()
  const deadlineState = useSwapDeadlineState()
  const recipientToggleState = useSwapRecipientToggleState()
  const hooksEnabledState = useHooksEnabledManager()
  const { isLoading: isRateLoading, bridgeQuote } = useTradeQuote()
  const hideQuoteAmount = useShouldHideTradeRateDetails()
  const priceImpact = useTradePriceImpact()
  const widgetActions = useSwapWidgetActions()
  const receiveAmountInfo = useGetReceiveAmountInfo()
  const { token: intermediateBuyToken, toBeImported } = useTryFindToken(getBridgeIntermediateTokenAddress(bridgeQuote))
  const [nativeWrapAmount, setNativeWrapAmount] = useState<CurrencyAmount<Currency> | null>(null)
  const [showAddIntermediateTokenModal, setShowAddIntermediateTokenModal] = useState(false)

  const dismissNativeWrapModal = useCallback(() => setNativeWrapAmount(null), [])

  const updateSwapState = useUpdateSwapRawState()

  const {
    inputCurrency,
    outputCurrency,
    inputCurrencyAmount,
    outputCurrencyAmount,
    inputCurrencyBalance,
    outputCurrencyBalance,
    inputCurrencyFiatAmount,
    outputCurrencyFiatAmount,
    recipient,
    recipientAddress,
    orderKind,
    isUnlocked,
  } = useSwapDerivedState()
  const doTrade = useHandleSwap({ deadline: deadlineState[0] }, widgetActions)
  const nativeFundingAmount = useSwapFundingAmount(true)
  const signedFundingAmount = useSwapFundingAmount()
  const showNativeWrapModal = !!nativeWrapAmount
  const wrapCallback = useWrapNativeFlow(nativeWrapAmount)
  const hasEnoughWrappedBalanceForSwap = useHasEnoughWrappedBalanceForSwap(nativeWrapAmount ?? signedFundingAmount)
  const openNativeWrapModal = useCallback(
    () => setNativeWrapAmount(hasEnoughWrappedBalanceForSwap ? signedFundingAmount : nativeFundingAmount),
    [hasEnoughWrappedBalanceForSwap, signedFundingAmount, nativeFundingAmount],
  )
  const isSmartContractWallet = useIsSmartContractWallet()
  const { account } = useWalletInfo()
  const isEagerConnectInProgress = useIsEagerConnectInProgress()
  const [isHydrated, setIsHydrated] = useState(false)
  const handleUnlock = useCallback(() => updateSwapState({ isUnlocked: true }), [updateSwapState])
  const isPrimaryValidationPassed = useIsTradeFormValidationPassed()

  useEffect(() => {
    // Hydration guard: defer lock-screen until persisted state (isUnlocked) loads to prevent initial flash.
    setIsHydrated(true)
  }, [])

  useEffect(() => {
    // Exact-output editing is for same-chain swaps; native bridges remain SELL-only.
    if (
      inputCurrency &&
      outputCurrency &&
      inputCurrency.chainId !== outputCurrency.chainId &&
      getIsNativeToken(inputCurrency) &&
      !isSmartContractWallet &&
      orderKind === OrderKind.BUY
    )
      updateSwapState({ orderKind: OrderKind.SELL, inputCurrencyAmount: null, outputCurrencyAmount: null })
  }, [inputCurrency, outputCurrency, isSmartContractWallet, orderKind, updateSwapState])

  const isSellTrade = isSellOrder(orderKind)

  const ethFlowProps: EthFlowProps = useSafeMemoObject({
    nativeInput: nativeWrapAmount || undefined,
    onDismiss: dismissNativeWrapModal,
    wrapCallback,
    directSwapCallback: doTrade.callback,
    hasEnoughWrappedBalanceForSwap,
  })

  const inputCurrencyInfo: CurrencyInfo = {
    label: isSellTrade && outputCurrency?.decimals === 0 ? t`Spend up to` : undefined,
    field: Field.INPUT,
    currency: inputCurrency,
    amount: inputCurrencyAmount,
    isIndependent: isSellTrade,
    balance: inputCurrencyBalance,
    fiatAmount: inputCurrencyFiatAmount,
    receiveAmountInfo: !isSellTrade ? receiveAmountInfo : null,
  }

  const outputCurrencyInfo: CurrencyInfo = {
    field: Field.OUTPUT,
    currency: outputCurrency,
    amount: direct.quote ? direct.output : outputCurrencyAmount,
    isIndependent: !isSellTrade,
    balance: outputCurrencyBalance,
    fiatAmount: direct.quote ? direct.fiat : outputCurrencyFiatAmount,
    receiveAmountInfo: !direct.quote && isSellTrade ? receiveAmountInfo : null,
  }

  const previewInput = isSellTrade
    ? (receiveAmountInfo?.amountsToSign.sellAmount ?? inputCurrencyAmount)
    : inputCurrencyAmount
  const { value: previewFiat } = useUsdAmount(previewInput)
  const inputCurrencyPreviewInfo = {
    amount: previewInput,
    fiatAmount: previewFiat,
    balance: inputCurrencyBalance,
    label: isSellTrade ? t`Sell amount` : t`Expected sell amount`,
  }

  const outputCurrencyPreviewInfo = {
    amount: outputCurrencyAmount,
    fiatAmount: outputCurrencyFiatAmount,
    balance: outputCurrencyBalance,
    label: isSellTrade ? t`Receive (before fees)` : t`Buy exactly`,
  }

  const rateInfoParams = useRateInfoParams(inputCurrencyAmount, outputCurrencyAmount)

  const buyingFiatAmount = useMemo(
    () => (isSellTrade ? outputCurrencyInfo.fiatAmount : inputCurrencyInfo.fiatAmount),
    [isSellTrade, outputCurrencyInfo.fiatAmount, inputCurrencyInfo.fiatAmount],
  )

  const handleImport = useCallback(() => {
    setShowAddIntermediateTokenModal(false)
  }, [])

  const handleCloseImportModal = useCallback(() => {
    setShowAddIntermediateTokenModal(false)
  }, [])

  const enablePartialApprovalState = useSwapPartialApprovalToggleState()

  const isConnected = Boolean(account)
  const isNetworkUnsupported = useIsProviderNetworkUnsupported()
  const isNetworkDeprecated = useIsProviderNetworkDeprecated()

  // Ophis: suppress the upstream CoW cross-chain unlock-promo
  // ("Cross-chain swaps are here / Mooove between any chain..."). It's
  // CoW-marketing copy that doesn't belong on Ophis. Tracked in
  // apps/frontend/.ophis-divergences.md.
  const shouldShowLockScreen = false
  void [
    isHydrated,
    isUnlocked,
    isNetworkUnsupported,
    isNetworkDeprecated,
    isConnected,
    isSmartContractWallet,
    isEagerConnectInProgress,
  ]

  const slots: TradeWidgetSlots = {
    headerContent,
    topContent,
    lockScreen: shouldShowLockScreen ? <CrossChainUnlockScreen handleUnlock={handleUnlock} /> : undefined,
    settingsWidget: (
      <SettingsTab
        recipientToggleState={recipientToggleState}
        hooksEnabledState={hooksEnabledState}
        deadlineState={deadlineState}
        enablePartialApprovalState={enablePartialApprovalState}
      />
    ),
    bottomContent: useCallback(
      (tradeWarnings: ReactNode | null) => {
        if (direct.loading) return <p role="status">{t`Comparing swap routes…`}</p>
        if (direct.quote)
          return (
            <>
              {bottomContent}
              <WholeTokenRoute
                refresh={direct.refresh}
                quote={direct.quote}
                requestKey={direct.requestKey}
                reviewed={direct.reviewed}
                review={direct.review}
              />
            </>
          )
        return (
          <>
            {bottomContent}
            {direct.comparisonFailed && (
              <InlineBanner bannerType={StatusColorVariant.Alert}>
                {t`Some swap routes could not be checked. A better quote may be available.`}{' '}
                <LinkStyledButton onClick={() => void direct.refresh()}>{t`Retry comparison`}</LinkStyledButton>
              </InlineBanner>
            )}
            {!hideQuoteAmount && <SwapRateDetails rateInfoParams={rateInfoParams} deadline={deadlineState[0]} />}
            {isPrimaryValidationPassed && <TradeApproveWithAffectedOrderList />}
            <Warnings buyingFiatAmount={buyingFiatAmount} hideQuoteAmount={hideQuoteAmount} />
            {tradeWarnings}
            <TradeButtons
              isTradeContextReady={doTrade.contextIsReady && !!nativeFundingAmount}
              openNativeWrapModal={openNativeWrapModal}
              hasEnoughWrappedBalanceForSwap={hasEnoughWrappedBalanceForSwap}
              tokenToBeImported={toBeImported}
              intermediateBuyToken={intermediateBuyToken}
              setShowAddIntermediateTokenModal={setShowAddIntermediateTokenModal}
            />
          </>
        )
      },
      [
        direct,
        bottomContent,
        rateInfoParams,
        deadlineState,
        buyingFiatAmount,
        doTrade.contextIsReady,
        nativeFundingAmount,
        openNativeWrapModal,
        hasEnoughWrappedBalanceForSwap,
        toBeImported,
        intermediateBuyToken,
        isPrimaryValidationPassed,
        hideQuoteAmount,
      ],
    ),
  }

  const params = {
    compactView: true,
    enableSmartSlippage: true,
    disableQuotePolling: direct.reviewed,
    disableTradeNotifications: direct.loading || !!direct.quote,
    isPriceStatic: !!direct.quote,
    disablePriceImpact: !!direct.quote,
    hideTradeWarnings: !!direct.quote,
    isMarketOrderWidget: true,
    allowSwapSameToken,
    recipient,
    showRecipient,
    isTradePriceUpdating: isRateLoading,
    priceImpact,
  }

  const genericModal = useMemo(
    () =>
      direct.reviewed && direct.quote ? (
        <WholeTokenReview
          quote={direct.quote}
          requestKey={direct.requestKey}
          reviewed
          review={direct.review}
          refresh={direct.refresh}
        />
      ) : (
        showNativeWrapModal && <EthFlowModal {...ethFlowProps} />
      ),
    [direct, showNativeWrapModal, ethFlowProps],
  )

  return (
    <Container>
      {showAddIntermediateTokenModal ? (
        <AddIntermediateTokenModal
          onDismiss={handleCloseImportModal}
          onBack={handleCloseImportModal}
          onImport={handleImport}
        />
      ) : (
        <TradeWidget
          slots={slots}
          actions={widgetActions}
          params={params}
          inputCurrencyInfo={inputCurrencyInfo}
          outputCurrencyInfo={outputCurrencyInfo}
          confirmModal={
            <SwapConfirmModal
              doTrade={doTrade.callback}
              recipient={recipient}
              recipientAddress={recipientAddress}
              priceImpact={priceImpact}
              inputCurrencyInfo={inputCurrencyPreviewInfo}
              outputCurrencyInfo={outputCurrencyPreviewInfo}
            />
          }
          genericModal={genericModal}
        />
      )}
      <BottomBanners />
    </Container>
  )
}
