import { lazy, ReactNode, Suspense, useEffect } from 'react'

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

// Ophis static brand surfaces (PR #234, 2026-05-22). Each is a static
// single-page component; lazy-loaded so the landing-page bundle stays lean.
const LegalPage = lazy(() => import(/* webpackChunkName: "ophis_legal" */ 'pages/Legal'))
const AboutPage = lazy(() => import(/* webpackChunkName: "ophis_about" */ 'pages/About'))
const BrandPage = lazy(() => import(/* webpackChunkName: "ophis_brand" */ 'pages/Brand'))

// PR #240 (2026-05-22 backlog batch): institutional pitch + trader ladder.
const InstitutionalPage = lazy(
  () => import(/* webpackChunkName: "ophis_institutional" */ 'pages/Institutional'),
)
const TiersPage = lazy(() => import(/* webpackChunkName: "ophis_tiers" */ 'pages/Tiers'))
// Phase C1 (2026-05-23): wallet-aware Profile page. Replaces the upstream
// `/profile → /account` Navigate alias with an Ophis identity surface.
// AGENTS.md compliance: named export — `.then(m => ({ default: m.X }))`
// wrapper adapts the barrel re-export to React.lazy()'s default-export
// contract without re-introducing a default export in the page module.
const ProfilePage = lazy(() =>
  import(/* webpackChunkName: "ophis_profile" */ 'pages/Profile').then((m) => ({
    default: m.ProfilePage,
  })),
)

// Account
const AccountTokensOverview = lazy(() => import(/* webpackChunkName: "tokens_overview" */ 'pages/Account/Tokens'))
const AccountAffiliatePartner = lazy(() => import(/* webpackChunkName: "affiliate" */ 'pages/Account/AffiliatePartner'))
const AccountAffiliateTrader = lazy(
  () => import(/* webpackChunkName: "affiliate_trader" */ 'pages/Account/AffiliateTrader'),
)
const AccountNotFound = lazy(() => import(/* webpackChunkName: "not_found" */ 'pages/error/NotFound'))

/**
 * /faq deep-links to the static /docs page's #faq section. /docs is
 * served from `public/docs/index.html` — NOT a React route — so a
 * client-side `<Navigate to="/docs#faq" />` would land on the SPA's
 * `*` NotFound catch-all. This component forces a full document
 * navigation via `window.location.assign` on mount, which the browser
 * resolves to the static asset + scrolls to the hash. Renders nothing.
 *
 * Codex PR #243 audit P1 closure (2026-05-22).
 */
function FaqRedirect(): null {
  useEffect(() => {
    window.location.assign('/docs#faq')
  }, [])
  return null
}

type LazyRouteProps = { route: RoutesValues; element: ReactNode; key?: number }

function LazyRoute({ route, element, key }: LazyRouteProps): ReactNode {
  return <Route key={key} path={route} element={<Suspense fallback={<Loading />}>{element}</Suspense>} />
}

// Ophis: routes that previously externally-redirected to cow.fi/* (FAQ_*,
// PRIVACY_POLICY, COOKIE_POLICY, TERMS_CONDITIONS, PLAY_COWRUNNER) removed
// in the 2026-05-20 rebrand. They now fall through to the `*` NotFound
// catch-all below. Restore once Ophis has its own equivalents.
//
// ABOUT, LEGAL, and BRAND wired below in PR #234 (2026-05-22) to closed
// Ophis-native static pages.
const lazyRoutes: LazyRouteProps[] = [
  { route: RoutesEnum.YIELD, element: <YieldPage /> },
  { route: RoutesEnum.LONG_LIMIT_ORDER, element: <RedirectToPath path={'/limit'} /> },
  { route: RoutesEnum.LONG_ADVANCED_ORDERS, element: <RedirectToPath path={'/advanced'} /> },
  { route: RoutesEnum.PLAY_MEVSLICER, element: <MevSlicer /> },
  { route: RoutesEnum.INSTITUTIONAL, element: <InstitutionalPage /> },
  { route: RoutesEnum.TIERS, element: <TiersPage /> },
  { route: RoutesEnum.PROFILE, element: <ProfilePage /> },
  // /faq deep-links to the FAQ section already in /docs (single source
  // of truth; avoids content duplication). `Navigate` preserves browser
  // refresh-on-/faq.
  // /faq → full-document redirect to /docs#faq. /docs is a static asset,
  // NOT a React route, so client-side Navigate would land on NotFound.
  // FaqRedirect calls window.location.assign on mount.
  { route: RoutesEnum.FAQ, element: <FaqRedirect /> },
  { route: RoutesEnum.ABOUT, element: <AboutPage /> },
  { route: RoutesEnum.LEGAL, element: <LegalPage /> },
  { route: RoutesEnum.BRAND, element: <BrandPage /> },
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
      {/* /profile is wired below via lazyRoutes (Phase C1, PR Profile page). */}

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
