import type { ReactNode } from 'react'

import { Accordion, Callout } from 'ophis/ds'

/**
 * Required disclosure hierarchy from the OTC spec: the primary warning is
 * always visible (never behind a tooltip); expanded context lives in an
 * accordion. Never describes any OTC operation as gas-free.
 */
export function OtcDisclosure(): ReactNode {
  return (
    <Callout tone="warning" title="Escrowed peer-to-peer orders — read the terms before interacting">
      <ul>
        <li>
          Assets in these orders are deposited into an external immutable escrow contract that Ophis does not operate
          and cannot pause.
        </li>
        <li>Creating and cancelling orders costs Ethereum gas; nothing on this surface is gas-free.</li>
        <li>Orders do not expire on-chain. An order stays open until it is filled or the maker cancels it.</li>
        <li>Fills are all-or-nothing. Partial fills are not supported.</li>
        <li>Public transactions may be raced by other participants.</li>
        <li>Only Ophis-reviewed assets are supported in this interface. Unreviewed tokens are shown read-only.</li>
      </ul>
      <Accordion summary="More about these risks">
        <p>
          The escrow contract is immutable and has no owner: Ophis cannot pause it, recover deposits, or modify existing
          orders. A maker&apos;s order stays fillable at its original price until the maker cancels it, no matter how
          far the market moves. Order data shown here is verified directly against Ethereum before it is labeled
          verified; index data alone is never treated as settlement authority.
        </p>
      </Accordion>
    </Callout>
  )
}
