import React from 'react'

import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'
import { Media } from '@cowprotocol/ui'

import { Helmet } from 'react-helmet'
import { useLocation } from 'react-router'
import styled from 'styled-components/macro'

import { subgraphApiSDK } from '../../../cowSdk'
import { useNetworkId } from '../../../state/network'
import { NETWORK_PREFIXES } from '../../../state/network/const'
import { Search } from '../../components/common/Search'
import { StatsSummaryCardsWidget } from '../../components/SummaryCardsWidget'
import { TokensTableWidget } from '../../components/TokensTableWidget'
import { APP_TITLE } from '../../const'
import { Wrapper as WrapperMod } from '../styled'

const Wrapper = styled(WrapperMod)`
  max-width: 100%;
  height: calc(100vh - 10rem);
  flex-flow: column wrap;
  justify-content: center;
  display: flex;
  padding: 0;

  ${Media.upToMedium()} {
    height: 50vh;
  }

  ${Media.upToSmall()} {
    padding: 0 1.6rem;
  }

  > h1 {
    justify-content: center;
    padding: 2.4rem 0 0.75rem;
    margin: 0 0 2.4rem;
    font-size: 2.4rem;
    line-height: 1;

    ${Media.upToExtraSmall()} {
      font-size: 1.7rem;
    }
  }
`

const SummaryWrapper = styled.section`
  display: flex;
  flex-direction: column;
  margin: 5rem 0 0 0;
  gap: 5rem;

  ${Media.upToSmall()} {
    padding-top: 4rem;
    max-width: 95vw;
  }

  ${Media.upToExtraSmall()} {
    padding-top: 3rem;
    max-width: 92vw;
  }
`

// Home renders at every network prefix (/, /optimism/, /arbitrum/, ...), so the
// same search page is reachable under many URLs. Point search engines at one
// canonical home and noindex the network-prefixed variants. Mirrors the
// canonical + prefixed-path noindex pattern on the Solvers page.
const HOME_CANONICAL_URL = 'https://explorer.ophis.fi/'

const SHOW_TOKENS_TABLE: Record<SupportedChainId, boolean> = {
  ...mapSupportedNetworks(false), // Default to false for all networks
  [SupportedChainId.MAINNET]: true, // Only show tokens table for mainnet
  // Ophis fork: OP mainnet (chain 10)
  [10 as unknown as SupportedChainId]: false,
  // Ophis fork: MegaETH mainnet (chain 4326)
  [4326 as unknown as SupportedChainId]: false,
  // Ophis fork: HyperEVM mainnet (chain 999)
  [999 as unknown as SupportedChainId]: false,
}

export const Home: React.FC = () => {
  const networkId = useNetworkId() ?? undefined
  const { pathname } = useLocation()
  const [, firstPathSegment, secondPathSegment] = pathname.split('/')
  const isPrefixedHomePath =
    firstPathSegment.length > 0 &&
    NETWORK_PREFIXES.split('|').includes(firstPathSegment) &&
    !secondPathSegment

  // LaunchDarkly removed (Ophis fork). Statically OFF: this preserves the prior
  // live behavior (CoW's LD context never resolved isTheGraphEnabled, so it was
  // falsy and the charts were hidden), and it avoids surfacing the StatsSummary /
  // TokensTable widgets — those query CoW's mainnet subgraph (needs an API key
  // Ophis doesn't ship, and would show CoW data, not Ophis orderbook data).
  const isTheGraphEnabled = false

  const showCharts = !!networkId && isTheGraphEnabled && subgraphApiSDK.SUBGRAPH_PROD_CONFIG[networkId] !== null
  const showTokensTable = !!networkId && isTheGraphEnabled && SHOW_TOKENS_TABLE[networkId]

  return (
    <Wrapper>
      <Helmet>
        <title>{APP_TITLE}</title>
        <link rel="canonical" href={HOME_CANONICAL_URL} />
        {isPrefixedHomePath && <meta name="robots" content="noindex,follow" />}
      </Helmet>
      <h1>Search on Ophis Explorer</h1>
      <Search className="home" />
      <SummaryWrapper>
        {showCharts && (
          <>
            <StatsSummaryCardsWidget />
            {showTokensTable && <TokensTableWidget networkId={networkId} />}
          </>
        )}
      </SummaryWrapper>
    </Wrapper>
  )
}

export default Home
