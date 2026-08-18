import { ReactNode, useRef } from 'react'

import { useMediaQuery } from '@cowprotocol/common-hooks'
import { ExplorerDataType, getExplorerLink, shortenAddress, getIsNativeToken } from '@cowprotocol/common-utils'
import { Media, ContextMenuTooltip, ContextMenuCopyButton, ContextMenuExternalLink, Opacity, UI } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useBridgeSupportedNetwork } from 'entities/bridgeProvider'
import { CheckCircle, Info } from 'react-feather'
import styled from 'styled-components/macro'

export type ClickableAddressProps = {
  address: string
  chainId: number
  showAddress?: boolean
  isContractVerified?: boolean
}

const Wrapper = styled.div<{ alwaysShow: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;

  &:hover {
    > button {
      opacity: ${Opacity.medium};
    }
  }

  > button {
    opacity: ${({ alwaysShow }) => (alwaysShow ? Opacity.medium : Opacity.none)};

    &:hover {
      opacity: ${Opacity.full};
    }
  }
`

const AddressWrapper = styled.span`
  margin: 0;
  line-height: 1;
  font-size: 13px;
  font-weight: 400;
  color: var(${UI.COLOR_TEXT_OPACITY_50});
  opacity: ${Opacity.full};
`

const ContractDetails = styled.div<{ $verified: boolean }>`
  width: 240px;
  padding: 8px 12px 10px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 4px 8px;
  color: ${({ $verified }) => ($verified ? `var(${UI.COLOR_SUCCESS})` : `var(${UI.COLOR_TEXT_OPACITY_70})`)};

  > svg {
    margin-top: 1px;
  }
`

const ContractStatus = styled.span`
  font-size: 13px;
  font-weight: 600;
`

const ContractAddress = styled.span`
  grid-column: 1 / -1;
  color: var(${UI.COLOR_TEXT_OPACITY_70});
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  overflow-wrap: anywhere;
`

export function ClickableAddress(props: ClickableAddressProps): ReactNode {
  const { address, chainId, showAddress = true, isContractVerified = false } = props

  const wrapperRef = useRef<HTMLDivElement>(null)
  const isMobile = useMediaQuery(Media.upToMedium(false))
  const bridgeNetwork = useBridgeSupportedNetwork(chainId)

  const shortAddress = shortenAddress(address)
  const target = getExplorerLink(chainId, address, ExplorerDataType.TOKEN, bridgeNetwork?.blockExplorer.url)
  const shouldShowAddress = target && !getIsNativeToken(chainId, address)

  return (
    shouldShowAddress && (
      <Wrapper alwaysShow={isMobile || !showAddress} ref={wrapperRef}>
        {showAddress ? <AddressWrapper>{shortAddress}</AddressWrapper> : null}
        <ContextMenuTooltip
          ariaLabel={t`View contract details`}
          content={
            <>
              <ContractDetails $verified={isContractVerified}>
                {isContractVerified ? <CheckCircle size={16} /> : <Info size={16} />}
                <ContractStatus>
                  {isContractVerified ? (
                    <Trans>Verified against an Ophis token list</Trans>
                  ) : (
                    <Trans>Contract address</Trans>
                  )}
                </ContractStatus>
                <ContractAddress>{address}</ContractAddress>
              </ContractDetails>
              <ContextMenuCopyButton address={address} label={t`Copy address`} />
              <ContextMenuExternalLink href={target} label={t`View on explorer`} />
            </>
          }
          placement="bottom"
          containerRef={wrapperRef}
        >
          <Info size={16} />
        </ContextMenuTooltip>
      </Wrapper>
    )
  )
}
