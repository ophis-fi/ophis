import styled from 'styled-components/macro'

import { Tr } from 'ophis/ds'

/**
 * Highlighted leaderboard row for the connected wallet. Saffron left rule +
 * faint saffron wash so the user can find themselves at a glance, mirroring
 * Jumper's "your row" treatment.
 */
export const SelfTr = styled(Tr)`
  background: rgba(242, 166, 62, 0.08);

  & > * {
    box-shadow: inset 3px 0 0 0 #f2a63e;
  }
`

/** Subtle "(you)" tag appended to the connected wallet's address cell. */
export const YouTag = styled.span`
  margin-left: 8px;
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #f2a63e;
`

/** Monospace numeric cell so volumes line up column-wise. */
export const Num = styled.span`
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-variant-numeric: tabular-nums;
`
