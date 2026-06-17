import { ReactNode, useEffect, useState } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { MultiCallUpdater } from '@cowprotocol/multicall'
import {
  RestrictedTokensListUpdater,
  TokensListsTagsUpdater,
  TokensListsUpdater,
  UnsupportedTokensUpdater,
} from '@cowprotocol/tokens'
import { HwAccountIndexUpdater, LegacyWalletUpdater, useWalletInfo, WalletUpdater } from '@cowprotocol/wallet'

import { CowSdkUpdater } from 'cowSdk'
import { useBalancesContext } from 'entities/balancesContext/useBalancesContext'
import { BridgeOrdersCleanUpdater } from 'entities/bridgeOrders'
import { BridgeProvidersUpdater, useBridgeSupportedNetworks } from 'entities/bridgeProvider'
import { CorrelatedTokensUpdater } from 'entities/correlatedTokens'
import { ThemeConfigUpdater } from 'theme/ThemeConfigUpdater'
import { TradingSdkUpdater } from 'tradingSdk/TradingSdkUpdater'

import { RefCodeCaptureUpdater } from 'modules/affiliate'
import { BalancesDevtools, CommonPriorityBalancesAndAllowancesUpdater } from 'modules/balancesAndAllowances'
import { PendingBridgeOrdersUpdater, BridgingEnabledUpdater } from 'modules/bridge'
import { BalancesCombinedUpdater } from 'modules/combinedBalances'
import { InFlightOrderFinalizeUpdater } from 'modules/ethFlow'
import { CowEventsUpdater, InjectedWidgetUpdater, useInjectedWidgetParams } from 'modules/injectedWidget'
import { FinalizeTxUpdater } from 'modules/onchainTransactions'
import {
  OrderProgressEventsUpdater,
  OrderProgressStateUpdater,
  ProgressBarExecutingOrdersUpdater,
} from 'modules/orderProgressBar'
import { OrdersNotificationsUpdater } from 'modules/orders'
import { GeoDataUpdater } from 'modules/rwa'
import { BlockedListSourcesUpdater, RecentTokensStorageUpdater, useSourceChainId } from 'modules/tokensList'
import { TradeType, useTradeTypeInfo } from 'modules/trade'
import { UsdPricesUpdater } from 'modules/usdAmount'
import { LpTokensWithBalancesUpdater, PoolsInfoUpdater, VampireAttackUpdater } from 'modules/yield'

import { SurplusInvalidationListenerUpdater } from 'common/state/totalSurplusState'
import { AnnouncementsUpdater } from 'common/updaters/AnnouncementsUpdater'
import { ConnectionStatusUpdater } from 'common/updaters/ConnectionStatusUpdater'
import { FeatureFlagsUpdater } from 'common/updaters/FeatureFlagsUpdater'
import { GasUpdater } from 'common/updaters/GasUpdater'
import { LpBalancesAndAllowancesUpdater } from 'common/updaters/LpBalancesAndAllowancesUpdater'
import {
  CancelledOrdersUpdater,
  ExpiredOrdersUpdater,
  OrdersFromApiUpdater,
  PendingOrdersUpdater,
} from 'common/updaters/orders'
import { SpotPricesUpdater } from 'common/updaters/orders/SpotPricesUpdater'
import { LastTimePriceUpdateResetUpdater } from 'common/updaters/orders/UnfillableOrdersUpdater'
import { ProviderNetworkSupportedUpdater } from 'common/updaters/ProviderNetworkSupportedUpdater'
import { SentryUpdater } from 'common/updaters/SentryUpdater'
import { SolversInfoUpdater } from 'common/updaters/SolversInfoUpdater'
import { ThemeFromUrlUpdater } from 'common/updaters/ThemeFromUrlUpdater'
import { UserUpdater } from 'common/updaters/UserUpdater'
import { WalletSessionDurationUpdater } from 'common/updaters/WalletSessionDurationUpdater'
import { WidgetTokensUpdater } from 'common/updaters/WidgetTokensUpdater'

import { FaviconAnimationUpdater } from './FaviconAnimationUpdater'

/**
 * Perf: defer the slow, non-critical CMS updaters (solvers / announcements /
 * correlated-tokens, all hitting cms.cow.fi: ~1s of boot-window network chatter)
 * off the critical first-paint path until the browser is idle. Each reads from a
 * persisted localStorage atom that defaults to [], so the UI degrades gracefully
 * (returning visitors keep their cached value) until the deferred fetch lands.
 */
function useDeferredMount(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => setReady(true), { timeout: 3000 })
      return () => window.cancelIdleCallback?.(id)
    }
    const t = window.setTimeout(() => setReady(true), 1500)
    return () => window.clearTimeout(t)
  }, [])
  return ready
}

export function Updaters(): ReactNode {
  const { account } = useWalletInfo()
  const deferred = useDeferredMount()

  const { standaloneMode } = useInjectedWidgetParams()
  const { isGeoBlockEnabled, isYieldEnabled, isRwaGeoblockEnabled } = useFeatureFlags()
  const tradeTypeInfo = useTradeTypeInfo()
  const isYieldWidget = tradeTypeInfo?.tradeType === TradeType.YIELD
  const { chainId: sourceChainId, source: sourceChainSource } = useSourceChainId()
  const bridgeNetworkInfo = useBridgeSupportedNetworks()
  const balancesContext = useBalancesContext()
  const balancesAccount = balancesContext.account || account

  return (
    <>
      <CowSdkUpdater />
      <FeatureFlagsUpdater />
      <BridgeProvidersUpdater />
      <ThemeConfigUpdater />
      <ThemeFromUrlUpdater />
      <ConnectionStatusUpdater />
      <TradingSdkUpdater />
      {/*Set custom chainId only when it differs from the wallet chainId*/}
      {/*MultiCallUpdater will use wallet network by default if custom chainId is not provided*/}
      <MultiCallUpdater chainId={sourceChainSource === 'wallet' ? undefined : sourceChainId} />
      <WalletUpdater standaloneMode={standaloneMode} />
      <LegacyWalletUpdater standaloneMode={standaloneMode} />
      <HwAccountIndexUpdater />
      <UserUpdater />
      <FinalizeTxUpdater />
      <PendingOrdersUpdater />
      <CancelledOrdersUpdater />
      <ExpiredOrdersUpdater />
      <OrdersFromApiUpdater />
      <GasUpdater />
      <SentryUpdater />
      <WalletSessionDurationUpdater />
      <InFlightOrderFinalizeUpdater />
      <SpotPricesUpdater />
      <InjectedWidgetUpdater />
      <CowEventsUpdater />
      <UsdPricesUpdater />
      <OrdersNotificationsUpdater />
      <OrderProgressStateUpdater />
      <ProgressBarExecutingOrdersUpdater />
      <OrderProgressEventsUpdater />
      {/* deferred to idle: post-trade solver cosmetics + CoW announcement banner (cms.cow.fi) */}
      {deferred && <SolversInfoUpdater />}
      {deferred && <AnnouncementsUpdater />}
      <SurplusInvalidationListenerUpdater />
      <BridgingEnabledUpdater />
      <FaviconAnimationUpdater />
      <ProviderNetworkSupportedUpdater />

      <TokensListsUpdater
        chainId={sourceChainId}
        isGeoBlockEnabled={isGeoBlockEnabled}
        enableLpTokensByDefault={isYieldWidget}
        isYieldEnabled={isYieldEnabled}
        bridgeNetworkInfo={bridgeNetworkInfo?.data}
      />
      <RestrictedTokensListUpdater isRwaGeoblockEnabled={!!isRwaGeoblockEnabled} />
      <BlockedListSourcesUpdater />
      <RecentTokensStorageUpdater />
      <GeoDataUpdater />
      <TokensListsTagsUpdater />

      <WidgetTokensUpdater />

      <UnsupportedTokensUpdater />
      <CommonPriorityBalancesAndAllowancesUpdater />
      <LpBalancesAndAllowancesUpdater chainId={sourceChainId} account={balancesAccount} enablePolling={isYieldWidget} />
      <PoolsInfoUpdater />
      <LpTokensWithBalancesUpdater />
      <VampireAttackUpdater />
      <BalancesCombinedUpdater />
      <BalancesDevtools />
      {/* deferred to idle: feeds the fee-waiver path; persisted atom keeps it revenue-safe (cms.cow.fi) */}
      {deferred && <CorrelatedTokensUpdater />}
      <BridgeOrdersCleanUpdater />
      <PendingBridgeOrdersUpdater />
      <LastTimePriceUpdateResetUpdater />

      {/* Ophis native affiliate: capture ?ref=CODE and bind on wallet connect. */}
      <RefCodeCaptureUpdater />
    </>
  )
}
