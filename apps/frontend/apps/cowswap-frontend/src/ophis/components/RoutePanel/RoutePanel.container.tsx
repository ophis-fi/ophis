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
 * inside collapsed details. That row counts the CMS-merged map while this panel
 * counts the sovereign registry, so on a sovereign chain they agree and on a
 * CoW-hosted chain only the row renders. That asymmetry is intentional.
 *
 * SOVEREIGN CHAINS ONLY, and the gate is `getOphisSolversForChain`, NOT a count of
 * the merged `useSolversInfo` map. On a CoW-hosted chain that map returns the CoW
 * CMS solvers, so a count-based gate renders this panel on Ethereum and tells the
 * user "Ophis runs a batch auction" about an order that is sent to api.cow.fi.
 * Ophis runs the auction only where Ophis runs the orderbook.
 */
import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'

import { useTradeState } from 'modules/trade'

import * as styledEl from './RoutePanel.styled'
import { useOphisSolverCopy } from './useOphisSolverCopy'

import { getOphisSolversForChain } from '../../solvers'

export function RoutePanel(): ReactNode {
  // The TRADE's chain, not the wallet's. useSetupTradeState applies the URL
  // state first and switches the wallet asynchronously ("the network chaning
  // process takes some time", useSetupTradeState.ts:41-44), so during that
  // window useWalletInfo() still reports the old chain. Keying off it would
  // show four Optimism solvers on a Unichain trade, or render this panel at all
  // when a sovereign-chain wallet opens an Ethereum trade.
  const { state } = useTradeState()
  const chainId = state?.chainId ?? undefined
  // The SOVEREIGN registry, not the CMS-merged map. See the note above.
  const solvers = getOphisSolversForChain(chainId)
  const solverCopy = useOphisSolverCopy()
  const total = solvers.length

  if (total === 0) return null

  return (
    <styledEl.Panel aria-labelledby="ophis-route-panel-title">
      <styledEl.Head>
        <styledEl.Title id="ophis-route-panel-title">
          <Trans>Route</Trans>
        </styledEl.Title>
        <styledEl.Count>{total === 1 ? <Trans>1 solver</Trans> : <Trans>up to {total} solvers</Trans>}</styledEl.Count>
      </styledEl.Head>

      <styledEl.Lede>
        {total === 1 ? (
          <Trans>Ophis runs a batch auction. 1 solver can compete for this order.</Trans>
        ) : (
          <Trans>Ophis runs a batch auction. Up to {total} solvers can compete for this order.</Trans>
        )}
      </styledEl.Lede>

      <styledEl.SectionLabel>
        <Trans>Configured to compete</Trans>
      </styledEl.SectionLabel>

      <styledEl.List>
        {solvers.map(({ solverId }) => (
          <styledEl.Row key={solverId} title={solverCopy.description(solverId)}>
            <styledEl.Dot aria-hidden="true" />
            <styledEl.RowLabel>{solverCopy.label(solverId)}</styledEl.RowLabel>
          </styledEl.Row>
        ))}
      </styledEl.List>

      <styledEl.Footer>
        <span>
          <Trans>
            No route is picked before you sign. Solvers build their routes during the auction, and the winning one is
            executed at settlement.
          </Trans>
        </span>
        <span>
          {/*
            Order-kind neutral on purpose. A SELL order signs a minimum BUY amount;
            a BUY order signs a maximum SELL amount. "match the minimum you signed"
            is only true for the sell case, and the form produces a buy order
            whenever the user types an exact output amount.
          */}
          <Trans>
            The winning solver must respect the limit you signed. Any improvement on it is returned to you as surplus.
          </Trans>
        </span>
      </styledEl.Footer>
    </styledEl.Panel>
  )
}
