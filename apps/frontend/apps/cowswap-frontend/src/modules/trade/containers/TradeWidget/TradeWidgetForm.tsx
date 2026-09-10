import React, { ReactNode, useCallback, useMemo } from 'react'

import ICON_ORDERS from '@cowprotocol/assets/svg/orders.svg'
import { useFeatureFlags, useTheme, useMediaQuery } from '@cowprotocol/common-hooks'
import { isInjectedWidget, isSellOrder, maxAmountSpend } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'
import { ButtonOutlined, Media, MY_ORDERS_ID, SWAP_HEADER_OFFSET } from '@cowprotocol/ui'
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
import { useOpenTokenSelectWidget } from 'modules/tokensList'
import { useDerivedTradeState } from 'modules/trade'
import { TradeFormValidation, useGetTradeFormValidation } from 'modules/tradeFormValidation'

import { useIsProviderNetworkDeprecated } from 'common/hooks/useIsProviderNetworkDeprecated'
import { useIsProviderNetworkUnsupported } from 'common/hooks/useIsProviderNetworkUnsupported'
import { useThrottleFn } from 'common/hooks/useThrottleFn'
import { CurrencyArrowSeparator } from 'common/pure/CurrencyArrowSeparator'
import { CurrencyInputPanel, CurrencyInputPanelProps } from 'common/pure/CurrencyInputPanel'
import { PoweredFooter } from 'common/pure/PoweredFooter'
import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import * as styledEl from './styled'
import { mapCurrencyInfo } from './TradeWidgetForm.utils'
import { TradeWidgetProps } from './types'

import { useTradeStateFromUrl } from '../../hooks/setupTradeState/useTradeStateFromUrl'
import { useIsCurrentTradeBridging } from '../../hooks/useIsCurrentTradeBridging'
import { useIsEoaEthFlow } from '../../hooks/useIsEoaEthFlow'
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
  const isWrapOrUnwrap = useIsWrapOrUnwrap()
  const { isLimitOrdersUpgradeBannerEnabled } = useFeatureFlags()
  const isCurrentTradeBridging = useIsCurrentTradeBridging()
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
    isSellingEthSupported = false,
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
  const isProviderNetworkUnsupported = useIsProviderNetworkUnsupported()
  const isProviderNetworkDeprecated = useIsProviderNetworkDeprecated()
  const isSafeWallet = useIsSafeWallet()
  const openTokenSelectWidget = useOpenTokenSelectWidget()
  const tradeStateFromUrl = useTradeStateFromUrl()
  const primaryFormValidation = useGetTradeFormValidation()
  const { shouldBeVisible: isLimitOrdersPromoBannerVisible } = useLimitOrdersPromoBanner()
  const isEoaEthFlow = useIsEoaEthFlow()
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
    tokenSelectorDisabled: shouldLockForAlternativeOrder,
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

  // Ophis sovereign chains are supported at the frontend layer.
  const isOutputTokenUnsupported =
    !!buyToken &&
    !(buyToken.chainId in SupportedChainId) &&
    buyToken.chainId !== 10 &&
    buyToken.chainId !== 130 &&
    buyToken.chainId !== 4663

  const { t } = useLingui()

  return (
    <>
      {isMobileSwap && <MobileSwapHeading />}
      <MobileSwapReveal enabled={!!isOphisMobileSwap}>
        <styledEl.ContainerBox data-mobile-swap-form={isOphisMobileSwap || undefined}>
          <styledEl.Header>
            {isOphisMobileSwap ? (
              <>
                <TradeWidgetLinks isDropdown />
                {headerContent}
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
                  <div>
                    <CurrencyInputPanel
                      id="input-currency-input"
                      currencyInfo={inputCurrencyInfo}
                      showSetMax={showSetMax}
                      maxBalance={maxBalance}
                      topLabel={
                        isOphisMobileSwap
                          ? inputCurrencyInfo.label || t`You pay`
                          : isWrapOrUnwrap
                            ? undefined
                            : inputCurrencyInfo.label
                      }
                      topContent={inputCurrencyInfo.topContent}
                      openTokenSelectWidget={openSellTokenSelect}
                      customSelectTokenButton={params.customSelectTokenButton}
                      {...currencyInputCommonProps}
                    />
                  </div>
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
                      isLoading={Boolean(sellToken && outputCurrencyInfo.currency && isTradePriceUpdating)}
                      disabled={
                        shouldLockForAlternativeOrder ||
                        isOutputTokenUnsupported ||
                        isNonEvmRecipientChain(buyToken?.chainId) ||
                        isProviderNetworkUnsupported ||
                        isProviderNetworkDeprecated
                      }
                      isDarkMode={darkMode}
                    />
                  </styledEl.CurrencySeparatorBox>
                  <div>
                    <CurrencyInputPanel
                      id="output-currency-input"
                      inputDisabled={
                        (isSellingEthSupported && isEoaEthFlow) ||
                        isWrapOrUnwrap ||
                        isCurrentTradeBridging ||
                        disableOutput
                      }
                      inputTooltip={
                        isSellingEthSupported && isEoaEthFlow
                          ? t`You cannot edit this field when selling` + ` ${inputCurrencyInfo?.currency?.symbol}`
                          : undefined
                      }
                      currencyInfo={outputCurrencyInfo}
                      priceImpactParams={!disablePriceImpact ? priceImpact : undefined}
                      topLabel={
                        isOphisMobileSwap
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
                  </div>
                  {withRecipient && (
                    <SetRecipient
                      recipient={recipient || ''}
                      onChangeRecipient={onChangeRecipient}
                      targetChainId={buyToken?.chainId as SupportedChainId}
                    />
                  )}

                  {isWrapOrUnwrap ? (
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
                </>
              )}

              {isInjectedWidgetMode && <PoweredFooter />}
            </>
          </LimitOrdersPromoBannerWrapper>
        </styledEl.ContainerBox>
      </MobileSwapReveal>
      {!isLimitOrdersPromoBannerVisible && !isLimitOrdersUpgradeBannerEnabled && outerContent && (
        <styledEl.OuterContentWrapper>{outerContent}</styledEl.OuterContentWrapper>
      )}
    </>
  )
}
