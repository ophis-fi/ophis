/**
 * "Route" panel for the swap page side rail.
 *
 * Ophis is an intent protocol: BEFORE you sign there is no route. Solvers compete
 * in a batch auction and the winner picks its venues at settlement. So this panel
 * deliberately does NOT draw a pre-trade path, and does not claim anyone is
 * currently bidding. It states what is CONFIGURED to compete, which is the only
 * thing the frontend can know pre-trade: no endpoint the app calls returns live
 * bid data before an order is posted.
 *
 * Solver names are rendered through `ophisSolverPublicLabel`, never from the CMS
 * `displayName` fallback, which prints the raw internal id (`kyberswap`, `okx`) on
 * any key mismatch. Ophis public copy never names a competitor: see the standing
 * rule in `ophis/solvers.ts`, enforced by `solvers.test.ts` BANNED_BRAND_TOKENS.
 *
 * The same count is also surfaced as a row inside the fee accordion
 * (`RowSolverCompetition`), which is the version reachable on narrow viewports and
 * inside the collapsed details. Both read the same `useSolversInfo` total, so they
 * cannot disagree.
 *
 * Renders nothing when the chain has no known solvers (every CoW-hosted chain, and
 * Unichain until chain 130 is added to the registry).
 */
import { ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans } from '@lingui/react/macro'

import { useSolversInfo } from 'common/hooks/useSolversInfo'

import { Count, Dot, Footer, Head, Lede, List, Panel, Row, RowLabel, SectionLabel, Title } from './RoutePanel.styled'

import { ophisSolverPublicDescription, ophisSolverPublicLabel } from '../../solvers'

export function RoutePanel(): ReactNode {
  const { chainId } = useWalletInfo()
  const solversInfo = useSolversInfo(chainId)
  const solverIds = Object.keys(solversInfo)
  const total = solverIds.length

  if (total === 0) return null

  return (
    <Panel aria-labelledby="ophis-route-panel-title">
      <Head>
        <Title id="ophis-route-panel-title">
          <Trans>Route</Trans>
        </Title>
        <Count>{total === 1 ? <Trans>1 solver</Trans> : <Trans>up to {total} solvers</Trans>}</Count>
      </Head>

      <Lede>
        {total === 1 ? (
          <Trans>Ophis runs a batch auction. 1 solver can compete for this order.</Trans>
        ) : (
          <Trans>Ophis runs a batch auction. Up to {total} solvers can compete for this order.</Trans>
        )}
      </Lede>

      <SectionLabel>
        <Trans>Configured to compete</Trans>
      </SectionLabel>

      <List>
        {solverIds.map((solverId) => (
          <Row key={solverId} title={ophisSolverPublicDescription(solverId)}>
            <Dot aria-hidden="true" />
            <RowLabel>{ophisSolverPublicLabel(solverId)}</RowLabel>
          </Row>
        ))}
      </List>

      <Footer>
        <span>
          <Trans>No route is picked before you sign. The winning solver chooses venues at settlement.</Trans>
        </span>
        <span>
          <Trans>
            The winning solver must at least match the minimum you signed. Any improvement is returned to you as
            surplus.
          </Trans>
        </span>
      </Footer>
    </Panel>
  )
}
