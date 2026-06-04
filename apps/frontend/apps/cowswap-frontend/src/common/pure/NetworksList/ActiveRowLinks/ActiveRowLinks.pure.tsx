import { ReactNode } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { Trans } from '@lingui/react/macro'

import * as styledEl from './ActiveRowLinks.styled'

export interface ActiveRowLinksProps {
  helpCenterUrl: string | undefined
  targetChainId: SupportedChainId
}

// Ophis: dropped the hardcoded "CoW Protocol Explorer" row and the per-chain
// block-explorer (Etherscan/Arbiscan) link. Also dropped the per-chain external
// "Bridge" link (e.g. bridge.optimism.io): it is obsolete now that Ophis bridges
// natively in-app via Bungee + Across (EVM to EVM) and NEAR Intents (Solana,
// Bitcoin); you just pick a destination chain in the token picker. Block-explorer
// links still appear on order receipts and transaction rows.
export function ActiveRowLinks({
  helpCenterUrl,
}: ActiveRowLinksProps): ReactNode {
  return (
    <styledEl.ActiveRowLinkList>
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
