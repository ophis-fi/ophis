import { ReactNode } from 'react'

import { PAGE_TITLES, WRAPPED_NATIVE_CURRENCIES as WETH } from '@cowprotocol/common-const'
import { isInjectedWidget } from '@cowprotocol/common-utils'
import { InlineBanner, StatusColorVariant } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useLingui } from '@lingui/react/macro'
import { OphisTrending, PriceChart, ReferralCta, RoutePanel } from 'ophis/components'
import { Navigate, NavLink, useLocation, useParams } from 'react-router'
import styled from 'styled-components/macro'

import { PageTitle } from 'modules/application'
import { swapDerivedStateAtom, SwapUpdaters, SwapWidget, useSwapDerivedStateToFill } from 'modules/swap'
import { parameterizeTradeRoute, getDefaultTradeRawState } from 'modules/trade'

import { Routes } from 'common/constants/routes'
import { HydrateAtom } from 'common/state/HydrateAtom'

const DcaLink = styled(NavLink)`
  color: inherit;
  display: inline;
  font-weight: 600;
  text-decoration: underline;

  &:hover {
    text-decoration: none;
  }
`

const DcaCta = (
  <InlineBanner bannerType={StatusColorVariant.Info} iconSize={32}>
    <strong>New: Set up a DCA.</strong> Buy on a schedule. MEV-protected, gas-free.{' '}
    <DcaLink to="/advanced">Try it &rarr;</DcaLink>
  </InlineBanner>
)

// The swap widget stays centered (margin auto). On wide viewports the side rail
// floats to its right without affecting the widget's own (dynamic) sizing; on
// narrower viewports (where there is no room beside the widget) it drops into
// normal flow, centered below the widget, instead of being hidden.
const SwapStage = styled.div`
  position: relative;
  width: 100%;
`

// ONE rail, not one float per panel. Each panel decides for itself whether to
// render, so the rail collapses cleanly: nothing at all on a chain with no
// solvers and no trending data.
//
// The geometry is deliberately unchanged from the single Trending float it
// replaces (same 250px offset, same 1181px gate, same z-index). Widening the
// offset is not free: TradeWidget expands its own max-width to 590px and 700px
// for the token-select views (modules/trade/containers/TradeWidget/styled.tsx),
// so a 700px widget already reaches centre + 350 and there is no
// `overflow-x: hidden` anywhere to catch an overlap. Move the gate before the
// offset.
const SideRail = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  margin-top: 16px;

  @media (min-width: 1181px) {
    position: absolute;
    top: 0;
    left: 50%;
    margin-left: 250px;
    margin-top: 0;
    align-items: stretch;
    z-index: 1;
  }
`

export function SwapPage(): ReactNode {
  const params = useParams()
  const { i18n } = useLingui()
  const swapDerivedStateToFill = useSwapDerivedStateToFill()

  if (!params.chainId) {
    return <SwapPageRedirect />
  }

  return (
    <HydrateAtom atom={swapDerivedStateAtom} state={swapDerivedStateToFill}>
      <PageTitle title={i18n._(PAGE_TITLES.SWAP)} />

      <SwapUpdaters />
      <SwapStage>
        {/* Partner iframe embeds keep the plain DCA banner: the referral CTA
            would route partner users to /profile inside the host's iframe. */}
        <SwapWidget topContent={isInjectedWidget() ? DcaCta : <ReferralCta fallback={DcaCta} />} />
        {/* Full app only. In an injected widget (partner iframe embeds) the rail is
            not mounted at all, so it never renders in or resizes a partner embed and
            no panel ever fetches a third-party API from one. */}
        {!isInjectedWidget() && (
          <SideRail>
            {/* Chart first: it is the highest-value content when the rail drops
                into normal flow below the widget on narrow viewports, where the
                Route panel's copy is already reachable in the fee accordion. */}
            <PriceChart />
            <RoutePanel />
            <OphisTrending />
          </SideRail>
        )}
      </SwapStage>
    </HydrateAtom>
  )
}

function SwapPageRedirect(): ReactNode {
  const { chainId } = useWalletInfo()
  const location = useLocation()

  if (!chainId) return null

  const defaultState = getDefaultTradeRawState(chainId)
  const searchParams = new URLSearchParams(location.search)
  const inputCurrencyId = searchParams.get('inputCurrency') || defaultState.inputCurrencyId || WETH[chainId]?.symbol
  const outputCurrencyId = searchParams.get('outputCurrency') || defaultState.outputCurrencyId || undefined

  searchParams.delete('inputCurrency')
  searchParams.delete('outputCurrency')
  searchParams.delete('chain')

  const pathname = parameterizeTradeRoute(
    {
      chainId: String(chainId),
      inputCurrencyId,
      outputCurrencyId,
      inputCurrencyAmount: undefined,
      outputCurrencyAmount: undefined,
      orderKind: undefined,
    },
    Routes.SWAP,
  )

  return <Navigate to={{ ...location, pathname, search: searchParams.toString() }} />
}
