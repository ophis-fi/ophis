import { ReactNode } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { Trans } from '@lingui/react/macro'

import * as styledEl from './ActiveRowLinks.styled'

export interface ActiveRowLinksProps {
  bridge: string | undefined
  explorer: string
  explorerTitle: string
  helpCenterUrl: string | undefined
  targetChainId: SupportedChainId
}

// Greg/Ophis: dropped the hardcoded "CoW Protocol Explorer" row.
// Block-explorer (Etherscan, Arbiscan, etc.) and bridge stay — those
// are chain-native resources, not CoW branding.
export function ActiveRowLinks({
  bridge,
  explorer,
  explorerTitle,
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
      {explorer && (
        <styledEl.ActiveRowLink href={explorer}>
          <styledEl.ActiveRowLinkLabel>{explorerTitle}</styledEl.ActiveRowLinkLabel>
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
