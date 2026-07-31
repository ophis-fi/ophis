/**
 * Post-settlement route diagram for a filled order (the second half of the
 * Route story: RoutePanel shows the pre-trade competition, this shows where the
 * WINNING solver actually sourced liquidity, drawn from settled on-chain data).
 *
 * SAFE RENDERING, deliberately boring: the SVG is embedded via
 * `<img src="data:image/svg+xml;base64,...">`. An SVG inside an <img> is a
 * replaced element: no script execution, no DOM access to the host page, even
 * if the backend's XML escaper were somehow bypassed. The token symbols and
 * venue labels inside that SVG are attacker-controlled on-chain strings, this
 * codebase has zero `dangerouslySetInnerHTML` occurrences, and this component
 * must not introduce the first. `img-src 'self' data: blob: https:` already
 * permits the data URI, so no CSP change either.
 *
 * The surplus callout is NOT restated here: the SVG renders it from a constant
 * pinned in the backend (model/src/pathviz.rs, "surplus returned vs your
 * signed minimum"). A duplicate HTML line would double-state it and drift.
 *
 * Renders nothing until the backend feature is live (the endpoint 404s while
 * `[pathviz] enabled = false`), nothing off chain 10, and nothing before the
 * order is traded. Silence is the correct failure mode everywhere: this is
 * decoration on an already-settled order.
 */
import { ReactNode } from 'react'

import { Trans, useLingui } from '@lingui/react/macro'

import * as styledEl from './SettlementRoute.styled'
import { usePathVizGraph } from './usePathVizGraph'

interface SettlementRouteProps {
  readonly chainId: number | undefined
  readonly orderUid: string | undefined
}

export function SettlementRoute({ chainId, orderUid }: SettlementRouteProps): ReactNode {
  const { t } = useLingui()
  const { response } = usePathVizGraph(chainId, orderUid)

  // Only a settled route is worth drawing: `quotedOnly` and `executing` graphs
  // describe a single-solver estimate, not what happened on-chain.
  if (!response || response.context !== 'traded') return null

  const venueLabels = response.graph.nodes.filter((node) => node.kind === 'venue').map((node) => node.label)

  // No picture AND no venues means there is nothing truthful to show.
  if (!response.svgBase64 && venueLabels.length === 0) return null

  return (
    <styledEl.Section aria-label={t`Settlement route`}>
      <h3>
        <Trans>Settlement route</Trans>
      </h3>
      <styledEl.Sub>
        <Trans>Where the winning solver sourced your liquidity.</Trans>
      </styledEl.Sub>

      {response.svgBase64 ? (
        <styledEl.Diagram
          src={`data:image/svg+xml;base64,${response.svgBase64}`}
          alt={t`Settlement route diagram for this order.`}
          loading="lazy"
        />
      ) : (
        // Backend rendered no image (a supported degradation): fall back to the
        // machine-readable graph. Labels are plain text nodes, never markup.
        <styledEl.VenueList>{venueLabels.join(' · ')}</styledEl.VenueList>
      )}
    </styledEl.Section>
  )
}
