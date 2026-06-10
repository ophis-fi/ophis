import { lazy, ReactNode, Suspense, useEffect } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { OphisPageLoader } from 'ophis/components'
import { IntentLanding } from 'ophis/components/intent'
import { Navigate, Route, Routes } from 'react-router'

import { RedirectPathToSwapOnly, RedirectToPath } from 'legacy/pages/Swap/redirects'

// Ophis: natural-language intent landing replaces upstream `/` redirect.
// docs/development/specs/2026-05-08-ophis-intent-input-design.md
// Branded page-level loader replaces cowswap's FlashingLoading.

import {
  AccountProxyWidgetPage,
  AccountProxyHelpPage,
  AccountProxyPage,
  AccountProxyRecoverPage,
  AccountProxiesPage,
} from 'modules/accountProxy'

import { Routes as RoutesEnum, RoutesValues } from 'common/constants/routes'
import Account from 'pages/Account'
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
// Phase A3 tail (2026-05-23): orientation/navigation hub page.
// AGENTS.md-compliant lazy pattern — see ProfilePage above.
const LearnPage = lazy(() =>
  import(/* webpackChunkName: "ophis_learn" */ 'pages/Learn').then((m) => ({
    default: m.LearnPage,
  })),
)
// Phase A3 (2026-05-25): trading-mechanism + CoW-vs-Ophis stack-delta page.
// AGENTS.md-compliant lazy pattern — see ProfilePage above.
const ProtocolPage = lazy(() =>
  import(/* webpackChunkName: "ophis_protocol" */ 'pages/Protocol').then((m) => ({
    default: m.ProtocolPage,
  })),
)
// Contact form (2026-05-27): relays to the Ophis inbox via /api/contact.
// AGENTS.md-compliant lazy pattern — see ProfilePage above.
const ContactPage = lazy(() =>
  import(/* webpackChunkName: "ophis_contact" */ 'pages/Contact').then((m) => ({
    default: m.ContactPage,
  })),
)
// Native affiliate program (rebates.ophis.fi). Self-serve /affiliate page +
// whitelist/signature-gated /partner dashboard. AGENTS.md-compliant lazy
// pattern — see ProfilePage above.
const AffiliatePage = lazy(() =>
  import(/* webpackChunkName: "ophis_affiliate" */ 'pages/Affiliate').then((m) => ({
    default: m.AffiliatePage,
  })),
)
const PartnerPage = lazy(() =>
  import(/* webpackChunkName: "ophis_partner" */ 'pages/Partner').then((m) => ({
    default: m.PartnerPage,
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
 * /faq deep-links to the FAQ page on the docs subdomain. Docs lives
 * at docs.ophis.fi (not a React route on ophis.fi). This component
 * forces a full document navigation via `window.location.assign` on
 * mount. Renders nothing.
 *
 * Codex PR #243 audit P1 closure (2026-05-22). Updated 2026-05-25 to
 * the multi-page portal's dedicated /faq page (the old single-page
 * /#faq anchor no longer exists).
 */
function FaqRedirect(): null {
  useEffect(() => {
    window.location.assign('https://docs.ophis.fi/faq')
  }, [])
  return null
}

/**
 * /docs route handler. Docs lives on docs.ophis.fi subdomain — bounce
 * the user there. Prevents the NotFound fall-through on /#/docs URLs
 * that escape emergency.js (e.g. client-side <Link to="/docs"> clicks
 * already inside the SPA).
 */
function DocsRedirect(): null {
  useEffect(() => {
    window.location.assign('https://docs.ophis.fi/')
  }, [])
  return null
}

/**
 * /institutional moved to the business.ophis.fi subdomain (2026-05-27).
 * Bounce any in-app or bookmarked /institutional hit to the business page.
 */
function InstitutionalRedirect(): null {
  useEffect(() => {
    window.location.assign('https://business.ophis.fi')
  }, [])
  return null
}

type LazyRouteProps = { route: RoutesValues; element: ReactNode; key?: number }

function LazyRoute({ route, element, key }: LazyRouteProps): ReactNode {
  return <Route key={key} path={route} element={<Suspense fallback={<OphisPageLoader />}>{element}</Suspense>} />
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
  { route: RoutesEnum.INSTITUTIONAL, element: <InstitutionalRedirect /> },
  { route: RoutesEnum.PROFILE, element: <ProfilePage /> },
  { route: RoutesEnum.AFFILIATE, element: <AffiliatePage /> },
  { route: RoutesEnum.PARTNER, element: <PartnerPage /> },
  { route: RoutesEnum.LEARN, element: <LearnPage /> },
  { route: RoutesEnum.PROTOCOL, element: <ProtocolPage /> },
  { route: RoutesEnum.CONTACT, element: <ContactPage /> },
  // /faq deep-links to the FAQ section already in /docs (single source
  // of truth; avoids content duplication). `Navigate` preserves browser
  // refresh-on-/faq.
  // /faq → full-document redirect to /docs#faq. /docs is a static asset,
  // NOT a React route, so client-side Navigate would land on NotFound.
  // FaqRedirect calls window.location.assign on mount.
  { route: RoutesEnum.FAQ, element: <FaqRedirect /> },
  { route: RoutesEnum.DOCS, element: <DocsRedirect /> },
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
        {/* Account overview was the COW/vCOW/governance/delegate dashboard (CoW-DAO
            token features Ophis doesn't have). Removed; /account now lands on Tokens. */}
        <Route path={RoutesEnum.ACCOUNT} element={<Navigate to={RoutesEnum.ACCOUNT_TOKENS} replace />} />
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
          <Suspense fallback={<OphisPageLoader />}>
            <NotFound />
          </Suspense>
        }
      />
    </Routes>
  )
}
