import { ReactNode } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { TokenLogo } from '@cowprotocol/tokens'
import { TokenName, TokenSymbol } from '@cowprotocol/ui'

import { ClickableAddress } from 'common/pure/ClickableAddress'

import { getTokenDisplayName } from './getTokenDisplayName.utils'
import * as styledEl from './styled'

import { TokenizedAssetProviderTag } from '../../types'
import { TokenContractDetails } from '../TokenContractDetails/TokenContractDetails.pure'

export interface TokenInfoProps {
  token: TokenWithLogo
  className?: string
  tags?: ReactNode
  showAddress?: boolean
  showContractInfo?: boolean
  hideNetworkBadge?: boolean
  isContractVerified?: boolean
  tokenizedAssetProvider?: TokenizedAssetProviderTag
}

export function TokenInfo(props: TokenInfoProps): ReactNode {
  const {
    token,
    className,
    tags,
    showAddress = true,
    showContractInfo = true,
    hideNetworkBadge = false,
    isContractVerified = false,
    tokenizedAssetProvider,
  } = props
  const displayName = getTokenDisplayName(token.name, token.tags, tokenizedAssetProvider)

  return (
    <styledEl.Wrapper className={className}>
      <TokenLogo token={token} sizeMobile={32} size={40} hideNetworkBadge={hideNetworkBadge} />
      <styledEl.TokenDetails>
        <styledEl.TokenSymbolWrapper>
          <TokenSymbol token={token} />
          {showContractInfo ? (
            <ClickableAddress
              address={token.address}
              chainId={token.chainId}
              showAddress={showAddress}
              details={<TokenContractDetails address={token.address} isContractVerified={isContractVerified} />}
            />
          ) : null}
        </styledEl.TokenSymbolWrapper>
        <styledEl.TokenNameRow>
          <TokenName token={{ name: displayName }} />
          {tags}
        </styledEl.TokenNameRow>
      </styledEl.TokenDetails>
    </styledEl.Wrapper>
  )
}
