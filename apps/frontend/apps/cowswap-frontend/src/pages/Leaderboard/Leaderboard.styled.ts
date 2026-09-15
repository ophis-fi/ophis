import { Tr } from 'ophis/ds'
import styled from 'styled-components/macro'

/** Highlight the connected wallet with a left rule and a contrasting surface. */
export const SelfTr = styled(Tr)`
  background: var(--cow-color-paper-darker);

  & > * {
    box-shadow: inset 3px 0 0 0 var(--cow-color-primary);
  }
`

/** Subtle "(you)" tag appended to the connected wallet's address cell. */
export const YouTag = styled.span`
  margin-left: 8px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cow-color-primary);
`

/** Monospace numeric cell so volumes line up column-wise. */
export const Num = styled.span`
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-variant-numeric: tabular-nums;
`
