import { ReactNode } from 'react'

import { PAGE_TITLES, WRAPPED_NATIVE_CURRENCIES as WETH } from '@cowprotocol/common-const'
import { InlineBanner, StatusColorVariant } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useLingui } from '@lingui/react/macro'
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
    <DcaLink to='/advanced'>Try it &rarr;</DcaLink>
  </InlineBanner>
)

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
      <SwapWidget topContent={DcaCta} />
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
