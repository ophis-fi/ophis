import { ReactNode } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { Trans } from '@lingui/react/macro'

import * as styledEl from './ActiveRowLinks.styled'

export interface ActiveRowLinksProps {
  bridge: string | undefined
  helpCenterUrl: string | undefined
  targetChainId: SupportedChainId
}

// Ophis: dropped the hardcoded "CoW Protocol Explorer" row and the per-chain
// block-explorer (Etherscan/Arbiscan) link — keep the network selector focused
// on Ophis actions (bridge + help). Block-explorer links still appear on order
// receipts / transaction rows, just not in the network dropdown.
export function ActiveRowLinks({
  bridge,
  helpCenterUrl,
}: ActiveRowLinksProps): ReactNode {
  return (
    <styledEl.ActiveRowLinkList>
      {bridge && (
        <styledEl.ActiveRowLink href={bridge}>
          <styledEl.ActiveRowLinkLabel>
            <Trans>Bridge</Trans>
          </styledEl.ActiveRowLinkLabel>
          <styledEl.LinkOutIconWrapper>
            <styledEl.LinkOutCircle aria-hidden="true" />
          </styledEl.LinkOutIconWrapper>
        </styledEl.ActiveRowLink>
      )}
      {helpCenterUrl && (
        <styledEl.ActiveRowLink href={helpCenterUrl}>
          <styledEl.ActiveRowLinkLabel>
            <Trans>Help Center</Trans>
          </styledEl.ActiveRowLinkLabel>
          <styledEl.LinkOutIconWrapper>
            <styledEl.LinkOutCircle aria-hidden="true" />
          </styledEl.LinkOutIconWrapper>
        </styledEl.ActiveRowLink>
      )}
    </styledEl.ActiveRowLinkList>
  )
}
