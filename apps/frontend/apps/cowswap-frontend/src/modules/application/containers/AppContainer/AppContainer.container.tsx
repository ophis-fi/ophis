import { type ReactNode, useEffect, useMemo, useState } from 'react'

import styled from 'styled-components/macro'

import { initPixelAnalytics, useAnalyticsReporter, useCowAnalytics, WebVitalsAnalytics } from '@cowprotocol/analytics'
import { isInjectedWidget } from '@cowprotocol/common-utils'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

// Ophis: route-aware chrome.
//   /          → chrome-less landing (IntentLanding handles its own).
//   anywhere   → Ophis header (wordmark + wallet controls) + Ophis footer.
// Cowswap's AppMenu, hiring banner, cow scene, snowfall, AMM banner are
// dropped wholesale. See apps/frontend/.ophis-divergences.md.
import { Link, useLocation } from 'react-router'

import { URLWarning } from 'legacy/components/Header/URLWarning'

import { OrdersPanel } from 'modules/account'
import { useInjectedWidgetMetaData } from 'modules/injectedWidget'
import { useInitializeUtm } from 'modules/utm'

import { InvalidLocalTimeWarning } from 'common/containers/InvalidLocalTimeWarning'
import { useCustomTheme } from 'common/hooks/useCustomTheme'
import { useGetMarketDimension } from 'common/hooks/useGetMarketDimension'

import { OphisFooter } from 'ophis/components/OphisFooter'
import { OphisHeader } from 'ophis/components/OphisHeader'
import { ScrollToTop } from 'ophis/components/ScrollToTop'
import { useOphisWalletFlag } from 'ophis/hooks/useOphisWalletFlag'

import { RecoveryBanner } from './RecoveryBanner'

import { PageBackgroundContext, PageBackgroundVariant } from '../../contexts/PageBackgroundContext'
import * as styledEl from '../App/styled'
import { NetworkAndAccountControls } from '../NetworkAndAccountControls/NetworkAndAccountControls.container'

// Initialize static analytics instance
const pixel = initPixelAnalytics()

// Ophis body wrapper — neutral dark surface for cowswap routes
// after we strip the upstream chrome. The cowswap swap-form internals
// keep their own card backgrounds; this just paints what's around them.
const OphisBodyWrapper = styled.div`
  flex: 1 1 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 56px 16px 64px;
  background: linear-gradient(180deg, #02000d 0%, #070328 50%, #02000d 100%);
  color: #f5efe6;

  & > * {
    margin: 0 auto;
  }
`

// Open Trade CTA — shown in the header right-slot on non-trade routes
// (about, tiers, legal, etc.) so users always have a one-click path
// back to the swap form. On actual trade routes, the existing
// NetworkAndAccountControls (chain dropdown + wallet button) takes the
// slot because users on those pages need the network/wallet UI to act.
const OpenTradeCTA = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  background: #f2a63e;
  color: #02000d;
  border-radius: 999px;
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-weight: 600;
  font-size: 14px;
  text-decoration: none;
  transition: filter 140ms ease-out, transform 140ms ease-out;
  &:hover,
  &:focus-visible {
    filter: brightness(1.06);
    transform: translateY(-1px);
  }
  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.55);
    outline-offset: 2px;
  }
`

// Trade route detection — pathname patterns the upstream cowswap
// modes use: /:chainId/(swap|limit|advanced|yield)/... — note `hooks`
// is `/swap/hooks` (matched via `swap`), not a top-level segment.
// `(?:/|$)` boundary prevents accidental matches like `/swapfoo` or
// `/advanced-orders`.
//
// Used to decide whether the header right-slot renders the
// network+wallet controls (trade routes) or the Open Trade CTA (info
// routes like /about, /tiers, /legal, etc.).
const TRADE_ROUTE_REGEX = /^\/(?:\d+\/)?(?:swap|limit|advanced|yield)(?:\/|$)/

function useIsTradeRoute(): boolean {
  const { pathname } = useLocation()
  return TRADE_ROUTE_REGEX.test(pathname)
}

interface AppContainerProps {
  children: ReactNode | ReactNode[]
}

/**
 * Subdomain → content map. Both subdomains share the same CF Pages
 * project (`greg`) which serves the cowswap-frontend SPA at root for
 * every host. To present different content per subdomain WITHOUT
 * separate Pages projects, we redirect at the SPA shell on first
 * paint:
 *   - `docs.ophis.fi/*`     → `/docs/` (static HTML served by CF Pages)
 *   - `business.ophis.fi/*` → `/business/` (static HTML in public/business/)
 *
 * The redirect preserves the subdomain in the URL bar. Future upgrade
 * path: when docs/business get their own CF Pages projects (own git
 * deploy + own content), this hook becomes a no-op + the projects
 * serve their roots directly.
 */
const SUBDOMAIN_ROUTING: Record<string, string> = {
  'docs.ophis.fi': '/docs/',
  'business.ophis.fi': '/business/',
}

function useSubdomainRedirect(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const target = SUBDOMAIN_ROUTING[window.location.hostname]
    // Only redirect if (a) we're on a known subdomain, AND (b) we're
    // currently at the root path — once redirected to e.g. /docs/, the
    // path is no longer `/` and this hook becomes a no-op on subsequent
    // navigations.
    if (target && window.location.pathname === '/') {
      window.location.replace(target)
    }
  }, [])
}

export function AppContainer({ children }: AppContainerProps): ReactNode {
  useSubdomainRedirect()
  const isTradeRoute = useIsTradeRoute()
  const { chainId, account } = useWalletInfo()
  const { walletName } = useWalletDetails()
  const cowAnalytics = useCowAnalytics()
  const webVitals = useMemo(() => new WebVitalsAnalytics(cowAnalytics), [cowAnalytics])

  useAnalyticsReporter({
    account,
    chainId,
    walletName,
    cowAnalytics,
    pixelAnalytics: pixel,
    webVitalsAnalytics: webVitals,
    marketDimension: useGetMarketDimension() || undefined,
    injectedWidgetAppId: useInjectedWidgetMetaData()?.appCode,
  })

  useOphisWalletFlag(!!account)
  useInitializeUtm()
  const isInjectedWidgetMode = isInjectedWidget()
  const isStandaloneLanding = useLocation().pathname === '/' && !isInjectedWidgetMode
  const [pageBackgroundVariant, setPageBackgroundVariant] = useState<PageBackgroundVariant>('default')
  const [pageScene, setPageScene] = useState<ReactNode | null>(null)

  const customTheme = useCustomTheme()
  const pageBackgroundValue = useMemo(
    () => ({
      variant: pageBackgroundVariant,
      setVariant: setPageBackgroundVariant,
      scene: pageScene,
      setScene: setPageScene,
    }),
    [pageBackgroundVariant, pageScene],
  )

  // Landing (`/`) handles its own chrome — render passthrough.
  if (isStandaloneLanding) {
    return (
      <PageBackgroundContext.Provider value={pageBackgroundValue}>
        <ScrollToTop />
        <styledEl.AppWrapper>{children}</styledEl.AppWrapper>
      </PageBackgroundContext.Provider>
    )
  }

  // Injected-widget mode is host-controlled — render minimal shell.
  if (isInjectedWidgetMode) {
    return (
      <PageBackgroundContext.Provider value={pageBackgroundValue}>
        <styledEl.AppWrapper>
          <styledEl.BodyWrapper customTheme={customTheme} backgroundVariant={pageBackgroundVariant}>
            {children}
            <styledEl.Marginer />
          </styledEl.BodyWrapper>
        </styledEl.AppWrapper>
      </PageBackgroundContext.Provider>
    )
  }

  // Every other route: Ophis chrome wrapping cowswap's body.
  return (
    <PageBackgroundContext.Provider value={pageBackgroundValue}>
      <ScrollToTop />
      <styledEl.AppWrapper>
        <URLWarning />
        <RecoveryBanner />
        <InvalidLocalTimeWarning />

        <OrdersPanel />

        <OphisHeader>
          {isTradeRoute ? (
            <NetworkAndAccountControls />
          ) : (
            <OpenTradeCTA to="/1/swap/_/_">Open Trade →</OpenTradeCTA>
          )}
        </OphisHeader>

        <OphisBodyWrapper>
          {children}
          <styledEl.Marginer />
        </OphisBodyWrapper>

        <OphisFooter />
      </styledEl.AppWrapper>
    </PageBackgroundContext.Provider>
  )
}
