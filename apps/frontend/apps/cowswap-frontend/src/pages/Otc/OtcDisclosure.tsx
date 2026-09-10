import type { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { Accordion, Callout } from 'ophis/ds'
import styled from 'styled-components/macro'

const Disclosure = styled(Callout)`
  padding: 24px;
  ul {
    gap: 12px;
    margin: 16px 0;
  }
  @media (min-width: 900px) {
    ul {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: 40px;
    }
  }
  @media (max-width: 600px) {
    padding: 16px;
  }
`

/**
 * Required disclosure hierarchy from the OTC spec: the primary warning is
 * always visible (never behind a tooltip); expanded context lives in an
 * accordion. Never describes any OTC operation as gas-free.
 */
export function OtcDisclosure(): ReactNode {
  return (
    <Disclosure tone="planned" title={<Trans>Escrowed peer-to-peer orders - read the terms before interacting</Trans>}>
      <ul>
        <li>
          <Trans>
            Assets in these orders are deposited into an external immutable escrow contract that Ophis does not operate
            and cannot pause.
          </Trans>
        </li>
        <li>
          <Trans>Creating and cancelling orders costs Ethereum gas; nothing on this surface is gas-free.</Trans>
        </li>
        <li>
          <Trans>Orders do not expire on-chain. An order stays open until it is filled or the maker cancels it.</Trans>
        </li>
        <li>
          <Trans>Fills are all-or-nothing. Partial fills are not supported.</Trans>
        </li>
        <li>
          <Trans>Public transactions may be raced by other participants.</Trans>
        </li>
        <li>
          <Trans>
            Only Ophis-reviewed assets are supported in this interface. Unreviewed tokens are shown read-only.
          </Trans>
        </li>
      </ul>
      <Accordion summary={<Trans>More about these risks</Trans>}>
        <p>
          <Trans>
            The escrow contract is immutable and has no owner: Ophis cannot pause it, recover deposits, or modify
            existing orders. A maker&apos;s order stays fillable at its original price until it is filled or the maker
            cancels it, no matter how far the market moves. Order data shown here is verified directly against Ethereum
            before it is labeled verified; index data alone is never treated as settlement authority.
          </Trans>
        </p>
      </Accordion>
    </Disclosure>
  )
}
