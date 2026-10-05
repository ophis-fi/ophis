import React, { ReactNode, Suspense, useCallback, useMemo } from 'react'

import ICON_ORDERS from '@cowprotocol/assets/svg/orders.svg'
import { useFeatureFlags, useTheme, useMediaQuery } from '@cowprotocol/common-hooks'
import { isInjectedWidget, isSellOrder, isSupportedChainId, maxAmountSpend } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'
import { ButtonOutlined, Loader, Media, MY_ORDERS_ID, SWAP_HEADER_OFFSET } from '@cowprotocol/ui'
import { useIsSafeWallet, useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { Trans, useLingui } from '@lingui/react/macro'
import { CoinbaseStockContext } from 'ophis/components/CoinbaseStockContext'
import { RobinhoodAssetContext } from 'ophis/components/RobinhoodAssetContext'
import { useIsMobileSwap } from 'ophis/hooks/useIsMobileSwap'
import { MobileSwapHeading } from 'ophis/mobile/MobileSwapHeading.pure'
import { MobileSwapReveal } from 'ophis/mobile/MobileSwapReveal.pure'
import SVG from 'react-inlinesvg'
import { Nullish } from 'types'

import { AccountElement } from 'legacy/components/Header/AccountElement'
import { Field } from 'legacy/state/types'

import { useToggleAccountModal } from 'modules/account'
import { useInjectedWidgetParams } from 'modules/injectedWidget'
import { useOpenTokenSelectWidget, useSelectTokenWidgetState } from 'modules/tokensList'
import { useDerivedTradeState } from 'modules/trade'
import { TradeFormValidation, useGetTradeFormValidation } from 'modules/tradeFormValidation'

import { useIsProviderNetworkDeprecated } from 'common/hooks/useIsProviderNetworkDeprecated'
import { useIsProviderNetworkUnsupported } from 'common/hooks/useIsProviderNetworkUnsupported'
import { useThrottleFn } from 'common/hooks/useThrottleFn'
import { CurrencyArrowSeparator } from 'common/pure/CurrencyArrowSeparator'
import { CurrencyInputPanel, CurrencyInputPanelProps } from 'common/pure/CurrencyInputPanel'
import { PoweredFooter } from 'common/pure/PoweredFooter'
import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import { isAssetSwapLayout } from './assetSwapLayout.utils'
import * as styledEl from './styled'
import { TradeSourceNetworkSelector } from './TradeSourceNetworkSelector'
import { mapCurrencyInfo } from './TradeWidgetForm.utils'
import { TradeWidgetProps } from './types'

import { useTradeStateFromUrl } from '../../hooks/setupTradeState/useTradeStateFromUrl'
import { useIsCurrentTradeBridging } from '../../hooks/useIsCurrentTradeBridging'
import { useIsQuoteUpdatePossible } from '../../hooks/useIsQuoteUpdatePossible'
import { useIsWrapOrUnwrap } from '../../hooks/useIsWrapOrUnwrap'
import { useLimitOrdersPromoBanner } from '../../hooks/useLimitOrdersPromoBanner'
import { useShouldHideQuoteAmounts } from '../../hooks/useShouldHideQuoteAmounts'
import { useTradeTypeInfoFromUrl } from '../../hooks/useTradeTypeInfoFromUrl'
import { SetRecipient } from '../../pure/SetRecipient'
import { useIsAlternativeOrderModalVisible } from '../../state/alternativeOrder'
import { TradeType } from '../../types'
import { LimitOrdersPromoBannerWrapper } from '../LimitOrdersPromoBannerWrapper'
import { QuotePolingProgress } from '../QuotePolingProgress'
import { TradeWarnings } from '../TradeWarnings'
import { TradeWidgetLinks } from '../TradeWidgetLinks'
import { WrapFlowActionButton } from '../WrapFlowActionButton'

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const scrollToMyOrders = () => {
  const element = document.getElementById(MY_ORDERS_ID)
  if (element) {
    const elementTop = element.getBoundingClientRect().top + window.scrollY - SWAP_HEADER_OFFSET
    window.scrollTo({ top: elementTop, behavior: 'smooth' })
  }
}

// TODO: Break down this large function into smaller functions
// TODO: Reduce function complexity by extracting logic
// eslint-disable-next-line max-lines-per-function, complexity
export function TradeWidgetForm(props: TradeWidgetProps): ReactNode {
  const isInjectedWidgetMode = isInjectedWidget()
  const { standaloneMode, hideOrdersTable } = useInjectedWidgetParams()
  const isMobile = useMediaQuery(Media.upToSmall(false))

  const tradeTypeInfo = useTradeTypeInfoFromUrl()
  const isAlternativeOrderModalVisible = useIsAlternativeOrderModalVisible()
  const isLimitOrderTrade = tradeTypeInfo?.tradeType === TradeType.LIMIT_ORDER
  const shouldLockForAlternativeOrder = isAlternativeOrderModalVisible && isLimitOrderTrade
  const isWrapOrUnwrap = useIsWrapOrUnwrap() && !props.params.externalFunding
  const { isLimitOrdersUpgradeBannerEnabled } = useFeatureFlags()
  const isCurrentTradeBridging = useIsCurrentTradeBridging() || !!props.params.externalFunding
  const { orderKind } = useDerivedTradeState() || {}
  const { darkMode, isOphisMobileSwap } = useTheme()
  const isMobileSwap = useIsMobileSwap()

  const isSellTrade = !!orderKind && isSellOrder(orderKind)
  const hideQuoteAmount = useShouldHideQuoteAmounts()

  const { slots, actions, params, disableOutput } = props
  const { headerContent, settingsWidget, lockScreen, topContent, middleContent, bottomContent, outerContent } = slots

  const { onCurrencySelection, onUserInput, onSwitchTokens, onChangeRecipient } = actions
  const {
    compactView,
    showRecipient,
    isTradePriceUpdating,
    priceImpact,
    recipient,
    hideTradeWarnings,
    enableSmartSlippage,
    displayTokenName = false,
    displayChainName = isCurrentTradeBridging,
    isMarketOrderWidget = false,
    isPriceStatic = false,
  } = params

  const inputCurrencyInfo = useMemo(() => {
    const info = isPriceStatic
      ? props.inputCurrencyInfo
      : mapCurrencyInfo(props.inputCurrencyInfo, !isSellTrade, hideQuoteAmount)

    if (isWrapOrUnwrap) {
      return { ...info, receiveAmountInfo: null }
    }

    return info
  }, [isWrapOrUnwrap, props.inputCurrencyInfo, hideQuoteAmount, isSellTrade, isPriceStatic])

  const outputCurrencyInfo = useMemo(() => {
    const info = isPriceStatic
      ? props.outputCurrencyInfo
      : mapCurrencyInfo(props.outputCurrencyInfo, isSellTrade, hideQuoteAmount)

    if (isWrapOrUnwrap) {
      return { ...info, amount: props.inputCurrencyInfo.amount, receiveAmountInfo: null }
    }

    return info
  }, [
    isWrapOrUnwrap,
    props.outputCurrencyInfo,
    props.inputCurrencyInfo.amount,
    hideQuoteAmount,
    isSellTrade,
    isPriceStatic,
  ])

  const { chainId, account } = useWalletInfo()
  const { allowsOffchainSigning } = useWalletDetails()
  const isProviderNetworkUnsupported = useIsProviderNetworkUnsupported() && !params.externalFunding
  const isProviderNetworkDeprecated = useIsProviderNetworkDeprecated() && !params.externalFunding
  const isSafeWallet = useIsSafeWallet()
  const openTokenSelectWidget = useOpenTokenSelectWidget(params.inputTokenOptions, params.outputTokenOptions)
  const tradeStateFromUrl = useTradeStateFromUrl()
  const primaryFormValidation = useGetTradeFormValidation()
  const { shouldBeVisible: isLimitOrdersPromoBannerVisible } = useLimitOrdersPromoBanner()
  const isQuoteUpdatePossible = useIsQuoteUpdatePossible()

  const sellToken = inputCurrencyInfo.currency
  const buyToken = outputCurrencyInfo.currency
  const areCurrenciesLoading = !sellToken && !buyToken
  const bothCurrenciesSet = !!sellToken && !!buyToken

  const hasRecipientInUrl = !!tradeStateFromUrl?.recipient
  const withRecipient =
    !isWrapOrUnwrap && (showRecipient || hasRecipientInUrl || !!recipient || isNonEvmRecipientChain(buyToken?.chainId))
  const maxBalance = maxAmountSpend(inputCurrencyInfo.balance || undefined, isSafeWallet)
  const showSetMax = maxBalance?.greaterThan(0) && !inputCurrencyInfo.amount?.equalTo(maxBalance)

  const disablePriceImpact =
    !!params.disablePriceImpact ||
    primaryFormValidation === TradeFormValidation.QuoteErrors ||
    primaryFormValidation === TradeFormValidation.CurrencyNotSupported ||
    primaryFormValidation === TradeFormValidation.WrapUnwrapFlow

  // Disable too frequent tokens switching
  const throttledOnSwitchTokens = useThrottleFn(onSwitchTokens, 500)

  const isUpToLarge = useMediaQuery(Media.upToLarge(false))

  const isConnectedMarketOrderWidget = !!account && isMarketOrderWidget

  const shouldShowMyOrdersButton =
    !shouldLockForAlternativeOrder &&
    (!isInjectedWidgetMode && isConnectedMarketOrderWidget ? isUpToLarge : true) &&
    (isConnectedMarketOrderWidget || !hideOrdersTable) &&
    ((isConnectedMarketOrderWidget && standaloneMode !== true && !lockScreen) ||
      (!isMarketOrderWidget && isUpToLarge && !lockScreen))

  const showDropdown = shouldShowMyOrdersButton || isInjectedWidgetMode || isMobile

  const currencyInputCommonProps = {
    isProviderNetworkUnsupported,
    isProviderNetworkDeprecated,
    chainId,
    areCurrenciesLoading,
    bothCurrenciesSet,
    onCurrencySelection,
    onUserInput,
    allowsOffchainSigning,
    tokenSelectorDisabled: shouldLockForAlternativeOrder || params.inputsDisabled,
    displayTokenName,
    displayChainName,
    isBridging: isCurrentTradeBridging,
  } as const satisfies Partial<CurrencyInputPanelProps>

  const openSellTokenSelect = useCallback(
    (selectedToken: Nullish<Currency>, field: Field | undefined, onSelectToken: (currency: Currency) => void) => {
      openTokenSelectWidget(selectedToken, field, buyToken || undefined, onSelectToken)
    },
    [openTokenSelectWidget, buyToken],
  )

  const openBuyTokenSelect = useCallback(
    (selectedToken: Nullish<Currency>, field: Field | undefined, onSelectToken: (currency: Currency) => void) => {
      openTokenSelectWidget(selectedToken, field, sellToken || undefined, onSelectToken)
    },
    [openTokenSelectWidget, sellToken],
  )

  const toggleAccountModal = useToggleAccountModal()

  const handleMyOrdersClick = useCallback(() => {
    if (isMarketOrderWidget) {
      toggleAccountModal()
    } else {
      scrollToMyOrders()
    }
  }, [isMarketOrderWidget, toggleAccountModal])

  const isOutputTokenUnsupported = !!buyToken && !isSupportedChainId(buyToken.chainId)

  const { t } = useLingui()

  const CurrencyFields = slots.currencyFields
  const assetSwapLayout = isAssetSwapLayout(params, slots)
  const { open, forceOpen, onSelectToken, field } = useSelectTokenWidgetState()
  // Quote polling pauses in the picker. Keep trade/settings controls inert
  // until it closes so a paused quote cannot enter approval or confirmation.
  const inlinePickerOpen = assetSwapLayout && Boolean((open || forceOpen) && onSelectToken && field)
  const reverseDisabled = !!(
    params.inputsDisabled ||
    params.disableTokenSwitch ||
    shouldLockForAlternativeOrder ||
    ((isOutputTokenUnsupported || isNonEvmRecipientChain(buyToken?.chainId)) && !params.externalFunding) ||
    isProviderNetworkUnsupported ||
    isProviderNetworkDeprecated
  )
  const reverseLoading = Boolean(sellToken && outputCurrencyInfo.currency && isTradePriceUpdating)
  const inputPanel = (
    <CurrencyInputPanel
      id="input-currency-input"
      allowUnsupportedTokenSelection={!!params.inputTokenOptions}
      inputDisabled={params.inputsDisabled}
      currencyInfo={inputCurrencyInfo}
      showSetMax={showSetMax && !params.inputsDisabled}
      maxBalance={maxBalance}
      topLabel={
        assetSwapLayout
          ? inputCurrencyInfo.label || t`You pay`
          : isOphisMobileSwap
            ? inputCurrencyInfo.label || t`You sell`
            : isWrapOrUnwrap
              ? undefined
              : inputCurrencyInfo.label
      }
      topContent={inputCurrencyInfo.topContent}
      openTokenSelectWidget={openSellTokenSelect}
      customSelectTokenButton={params.customSelectTokenButton}
      {...currencyInputCommonProps}
    />
  )
  const outputPanel = (
    <CurrencyInputPanel
      id="output-currency-input"
      inputDisabled={isWrapOrUnwrap || isCurrentTradeBridging || disableOutput}
      currencyInfo={outputCurrencyInfo}
      priceImpactParams={!disablePriceImpact ? priceImpact : undefined}
      topLabel={
        assetSwapLayout
          ? outputCurrencyInfo.label || t`You receive`
          : isOphisMobileSwap
            ? outputCurrencyInfo.label || t`You receive`
            : isWrapOrUnwrap
              ? undefined
              : outputCurrencyInfo.label
      }
      topContent={outputCurrencyInfo.topContent}
      openTokenSelectWidget={openBuyTokenSelect}
      customSelectTokenButton={params.customSelectTokenButton}
      {...currencyInputCommonProps}
    />
  )

  return (
    <>
      {isMobileSwap && <MobileSwapHeading />}
      <MobileSwapReveal enabled={!!isOphisMobileSwap}>
        <styledEl.ContainerBox data-mobile-swap-form={isOphisMobileSwap || undefined}>
          <styledEl.Header inert={inlinePickerOpen}>
            {isOphisMobileSwap ? (
              <>
                {isMobileSwap && <TradeWidgetLinks isDropdown />}
                {params.inputTokenOptions ? (
                  <TradeSourceNetworkSelector widget={props} openTokenSelectWidget={openTokenSelectWidget} />
                ) : (
                  headerContent
                )}
              </>
            ) : shouldLockForAlternativeOrder ? (
              <div></div>
            ) : (
              <TradeWidgetLinks isDropdown={showDropdown} />
            )}
            {isInjectedWidgetMode && standaloneMode && <AccountElement />}

            {shouldShowMyOrdersButton && !isOphisMobileSwap && (
              <ButtonOutlined margin={'0 16px 0 auto'} onClick={handleMyOrdersClick}>
                <Trans>
                  My orders <SVG src={ICON_ORDERS} />
                </Trans>
              </ButtonOutlined>
            )}

            <styledEl.HeaderRight>
              {!lockScreen && (
                <>
                  {!isPriceStatic && !showDropdown && isQuoteUpdatePossible && <QuotePolingProgress />}
                  {settingsWidget}
                </>
              )}
            </styledEl.HeaderRight>
          </styledEl.Header>

          <LimitOrdersPromoBannerWrapper>
            <>
              {lockScreen ? (
                lockScreen
              ) : (
                <>
                  <div inert={inlinePickerOpen} style={{ display: 'contents' }}>
                    {topContent}
                    <RobinhoodAssetContext
                      chainId={chainId}
                      sellToken={sellToken}
                      buyToken={buyToken}
                      sellBalance={inputCurrencyInfo.balance}
                    />
                    <CoinbaseStockContext
                      chainId={chainId}
                      sellToken={sellToken}
                      buyToken={buyToken}
                      sellBalance={inputCurrencyInfo.balance}
                    />
                  </div>
                  {assetSwapLayout && CurrencyFields ? (
                    <Suspense
                      fallback={
                        <div className="swp-loading" role="status">
                          <Loader />
                          <Trans>Loading swap controls…</Trans>
                        </div>
                      }
                    >
                      <CurrencyFields
                        input={inputPanel}
                        output={outputPanel}
                        reverse={{ onClick: onSwitchTokens, disabled: reverseDisabled, loading: reverseLoading }}
                      />
                    </Suspense>
                  ) : (
                    <>
                      <div>{inputPanel}</div>
                      {!isWrapOrUnwrap && middleContent}
                      <styledEl.CurrencySeparatorBox compactView={compactView}>
                        <CurrencyArrowSeparator
                          isCollapsed={compactView}
                          hasSeparatorLine={!compactView}
                          onSwitchTokens={
                            isProviderNetworkUnsupported || isProviderNetworkDeprecated
                              ? () => void 0
                              : throttledOnSwitchTokens
                          }
                          isLoading={reverseLoading}
                          disabled={reverseDisabled}
                          isDarkMode={darkMode}
                        />
                      </styledEl.CurrencySeparatorBox>
                      <div>{outputPanel}</div>
                    </>
                  )}
                  {withRecipient && (
                    <fieldset
                      disabled={params.inputsDisabled}
                      inert={inlinePickerOpen}
                      style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                    >
                      <SetRecipient
                        recipient={recipient || ''}
                        onChangeRecipient={onChangeRecipient}
                        targetChainId={buyToken?.chainId as SupportedChainId}
                      />
                    </fieldset>
                  )}

                  <div inert={inlinePickerOpen} style={{ display: 'contents' }}>
                    {isWrapOrUnwrap && !isPriceStatic ? (
                      sellToken ? (
                        <WrapFlowActionButton sellToken={sellToken} />
                      ) : null
                    ) : (
                      bottomContent?.(
                        hideTradeWarnings ? null : (
                          <TradeWarnings
                            enableSmartSlippage={enableSmartSlippage}
                            isTradePriceUpdating={isTradePriceUpdating}
                          />
                        ),
                      )
                    )}
                  </div>
                </>
              )}

              {isInjectedWidgetMode && <PoweredFooter />}
            </>
          </LimitOrdersPromoBannerWrapper>
        </styledEl.ContainerBox>
      </MobileSwapReveal>
      {!isLimitOrdersPromoBannerVisible && !isLimitOrdersUpgradeBannerEnabled && outerContent && (
        <styledEl.OuterContentWrapper inert={inlinePickerOpen}>{outerContent}</styledEl.OuterContentWrapper>
      )}
    </>
  )
}
