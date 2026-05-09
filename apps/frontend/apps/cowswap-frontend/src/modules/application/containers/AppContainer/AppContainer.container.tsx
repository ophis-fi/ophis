import { type ReactNode, useMemo, useState } from 'react'

import styled from 'styled-components/macro'

import { initPixelAnalytics, useAnalyticsReporter, useCowAnalytics, WebVitalsAnalytics } from '@cowprotocol/analytics'
import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { isInjectedWidget } from '@cowprotocol/common-utils'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

// Greg/Ophis: route-aware chrome.
//   /          → chrome-less landing (IntentLanding handles its own).
//   anywhere   → Ophis header (wordmark + wallet controls) + Ophis footer.
// Cowswap's AppMenu, hiring banner, cow scene, snowfall, AMM banner are
// dropped wholesale. See apps/frontend/.greg-divergences.md.
import { useLocation } from 'react-router'

import { URLWarning } from 'legacy/components/Header/URLWarning'

import { OrdersPanel } from 'modules/account'
import { AffiliateTraderModal } from 'modules/affiliate'
import { useInjectedWidgetMetaData } from 'modules/injectedWidget'
import { useInitializeUtm } from 'modules/utm'

import { InvalidLocalTimeWarning } from 'common/containers/InvalidLocalTimeWarning'
import { useCustomTheme } from 'common/hooks/useCustomTheme'
import { useGetMarketDimension } from 'common/hooks/useGetMarketDimension'

import { OphisFooter } from 'greg/components/OphisFooter'
import { OphisHeader } from 'greg/components/OphisHeader'

import { RecoveryBanner } from './RecoveryBanner'

import { PageBackgroundContext, PageBackgroundVariant } from '../../contexts/PageBackgroundContext'
import * as styledEl from '../App/styled'
import { NetworkAndAccountControls } from '../NetworkAndAccountControls/NetworkAndAccountControls.container'

// Initialize static analytics instance
const pixel = initPixelAnalytics()

// Greg/Ophis body wrapper — neutral dark surface for cowswap routes
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

interface AppContainerProps {
  children: ReactNode | ReactNode[]
}

export function AppContainer({ children }: AppContainerProps): ReactNode {
  const { chainId, account } = useWalletInfo()
  const { walletName } = useWalletDetails()
  const cowAnalytics = useCowAnalytics()
  const webVitals = useMemo(() => new WebVitalsAnalytics(cowAnalytics), [cowAnalytics])
  const { isAffiliateProgramEnabled } = useFeatureFlags()

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
      <styledEl.AppWrapper>
        <URLWarning />
        <RecoveryBanner />
        <InvalidLocalTimeWarning />

        <OrdersPanel />

        <OphisHeader>
          <NetworkAndAccountControls />
        </OphisHeader>

        <OphisBodyWrapper>
          {children}
          <styledEl.Marginer />
        </OphisBodyWrapper>

        <OphisFooter />

        {isAffiliateProgramEnabled && <AffiliateTraderModal />}
      </styledEl.AppWrapper>
    </PageBackgroundContext.Provider>
  )
}
