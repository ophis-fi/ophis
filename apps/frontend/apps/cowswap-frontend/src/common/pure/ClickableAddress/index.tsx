import { ReactNode, useRef } from 'react'

import { useMediaQuery } from '@cowprotocol/common-hooks'
import { ExplorerDataType, getExplorerLink, shortenAddress, getIsNativeToken } from '@cowprotocol/common-utils'
import { Media, ContextMenuTooltip, ContextMenuCopyButton, ContextMenuExternalLink } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'
import { useBridgeSupportedNetwork } from 'entities/bridgeProvider'
import { Info } from 'react-feather'

import * as styledEl from './ClickableAddress.styled'

export type ClickableAddressProps = {
  address: string
  chainId: number
  showAddress?: boolean
  details: ReactNode
}

export function ClickableAddress(props: ClickableAddressProps): ReactNode {
  const { address, chainId, showAddress = true, details } = props

  const wrapperRef = useRef<HTMLDivElement>(null)
  const isMobile = useMediaQuery(Media.upToMedium(false))
  const bridgeNetwork = useBridgeSupportedNetwork(chainId)

  const shortAddress = shortenAddress(address)
  const target = getExplorerLink(chainId, address, ExplorerDataType.TOKEN, bridgeNetwork?.blockExplorer.url)
  const shouldShowAddress = target && !getIsNativeToken(chainId, address)

  return (
    shouldShowAddress && (
      <styledEl.Wrapper $alwaysShow={isMobile || !showAddress} ref={wrapperRef}>
        {showAddress ? <styledEl.AddressWrapper>{shortAddress}</styledEl.AddressWrapper> : null}
        <ContextMenuTooltip
          ariaLabel={t`View contract details`}
          content={
            <>
              {details}
              <ContextMenuCopyButton address={address} label={t`Copy address`} />
              <ContextMenuExternalLink href={target} label={t`View on explorer`} />
            </>
          }
          placement="bottom"
          containerRef={wrapperRef}
        >
          <Info size={16} />
        </ContextMenuTooltip>
      </styledEl.Wrapper>
    )
  )
}
