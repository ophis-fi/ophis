import { lazy, ReactNode, Suspense } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { Navigate, Route, Routes } from 'react-router'

import { Loading } from 'legacy/components/FlashingLoading'
import { RedirectPathToSwapOnly, RedirectToPath } from 'legacy/pages/Swap/redirects'

// Ophis: natural-language intent landing replaces upstream `/` redirect.
// docs/development/specs/2026-05-08-ophis-intent-input-design.md
import { IntentLanding } from 'ophis/components/intent'

import {
  AccountProxyWidgetPage,
  AccountProxyHelpPage,
  AccountProxyPage,
  AccountProxyRecoverPage,
  AccountProxiesPage,
} from 'modules/accountProxy'

import { Routes as RoutesEnum, RoutesValues } from 'common/constants/routes'
import Account, { AccountOverview } from 'pages/Account'
import { AdvancedOrdersPage } from 'pages/AdvancedOrders/AdvancedOrders.page'
import AnySwapAffectedUsers from 'pages/error/AnySwapAffectedUsers'
import { HooksPage } from 'pages/Hooks'
import { LimitOrdersPage } from 'pages/LimitOrders/LimitOrders.page'
import { SwapPage } from 'pages/Swap'
import YieldPage from 'pages/Yield'

// Async routes
const NotFound = lazy(() => import(/* webpackChunkName: "not_found" */ 'pages/error/NotFound'))
const MevSlicer = lazy(() => import(/* webpackChunkName: "mev_slicer" */ 'pages/games/MevSlicer'))

// Account
const AccountTokensOverview = lazy(() => import(/* webpackChunkName: "tokens_overview" */ 'pages/Account/Tokens'))
const AccountAffiliatePartner = lazy(() => import(/* webpackChunkName: "affiliate" */ 'pages/Account/AffiliatePartner'))
const AccountAffiliateTrader = lazy(
  () => import(/* webpackChunkName: "affiliate_trader" */ 'pages/Account/AffiliateTrader'),
)
const AccountNotFound = lazy(() => import(/* webpackChunkName: "not_found" */ 'pages/error/NotFound'))

type LazyRouteProps = { route: RoutesValues; element: ReactNode; key?: number }

function LazyRoute({ route, element, key }: LazyRouteProps): ReactNode {
  return <Route key={key} path={route} element={<Suspense fallback={<Loading />}>{element}</Suspense>} />
}

// Ophis: routes that previously externally-redirected to cow.fi/* (ABOUT,
// FAQ_*, PRIVACY_POLICY, COOKIE_POLICY, TERMS_CONDITIONS, PLAY_COWRUNNER)
// removed in the 2026-05-20 rebrand. They now fall through to the `*`
// NotFound catch-all below. Restore once Ophis has its own equivalents.
const lazyRoutes: LazyRouteProps[] = [
  { route: RoutesEnum.YIELD, element: <YieldPage /> },
  { route: RoutesEnum.LONG_LIMIT_ORDER, element: <RedirectToPath path={'/limit'} /> },
  { route: RoutesEnum.LONG_ADVANCED_ORDERS, element: <RedirectToPath path={'/advanced'} /> },
  { route: RoutesEnum.PLAY_MEVSLICER, element: <MevSlicer /> },
]

export function RoutesApp(): ReactNode {
  const { isAffiliateProgramEnabled } = useFeatureFlags()

  return (
    <Routes>
      {/*Account*/}
      <Route path={RoutesEnum.ACCOUNT} element={<Account />}>
        <Route path={RoutesEnum.ACCOUNT} element={<AccountOverview />} />
        <Route path={RoutesEnum.ACCOUNT_TOKENS} element={<AccountTokensOverview />} />
        {isAffiliateProgramEnabled && (
          <Route path={RoutesEnum.ACCOUNT_AFFILIATE_PARTNER} element={<AccountAffiliatePartner />} />
        )}
        {isAffiliateProgramEnabled && (
          <Route path={RoutesEnum.ACCOUNT_AFFILIATE_TRADER} element={<AccountAffiliateTrader />} />
        )}
        <Route path="*" element={<AccountNotFound />} />
      </Route>

      <Route path={RoutesEnum.ACCOUNT_PROXIES} element={<AccountProxyWidgetPage />}>
        <Route path={RoutesEnum.ACCOUNT_PROXY} element={<AccountProxyPage />} />
        <Route path={RoutesEnum.ACCOUNT_PROXY_RECOVER} element={<AccountProxyRecoverPage />} />
        <Route path={RoutesEnum.ACCOUNT_PROXY_HELP} element={<AccountProxyHelpPage />} />
        <Route index element={<AccountProxiesPage />} />
      </Route>
      <Route path="claim" element={<Navigate to={RoutesEnum.ACCOUNT} />} />
      <Route path="profile" element={<Navigate to={RoutesEnum.ACCOUNT} />} />

      {/*Swap*/}
      <Route path={RoutesEnum.SWAP} element={<SwapPage />} />
      <Route path={RoutesEnum.LIMIT_ORDERS} element={<LimitOrdersPage />} />
      <Route path={RoutesEnum.ADVANCED_ORDERS} element={<AdvancedOrdersPage />} />
      <Route path={RoutesEnum.HOOKS} element={<HooksPage />} />
      <Route path={RoutesEnum.SEND} element={<RedirectPathToSwapOnly />} />

      {lazyRoutes.map((item, key) => LazyRoute({ ...item, key }))}

      <Route path={RoutesEnum.ANYSWAP_AFFECTED} element={<AnySwapAffectedUsers />} />

      {/* Ophis: `/` shows the intent landing instead of redirecting to /swap. */}
      <Route path={RoutesEnum.HOME} element={<IntentLanding />} />
      <Route
        path="*"
        element={
          <Suspense fallback={<Loading />}>
            <NotFound />
          </Suspense>
        }
      />
    </Routes>
  )
}
