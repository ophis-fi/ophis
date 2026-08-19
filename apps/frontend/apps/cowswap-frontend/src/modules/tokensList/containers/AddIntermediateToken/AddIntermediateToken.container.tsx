import { ReactNode } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { getTokenId } from '@cowprotocol/cow-sdk'

import { useConfiguredTokenListDisplayMetadata } from '../../hooks/useConfiguredTokenListDisplayMetadata'
import { AddIntermediateToken as AddIntermediateTokenPure } from '../../pure/AddIntermediateToken'

interface AddIntermediateTokenProps {
  intermediateBuyToken: TokenWithLogo
  onImport: () => void
}

export function AddIntermediateToken({ intermediateBuyToken, onImport }: AddIntermediateTokenProps): ReactNode {
  const { listedTokenIds, tokenizedAssetProviderByTokenId, tokenListTags } = useConfiguredTokenListDisplayMetadata(
    intermediateBuyToken.chainId,
  )
  const tokenId = getTokenId(intermediateBuyToken)

  return (
    <AddIntermediateTokenPure
      intermediateBuyToken={intermediateBuyToken}
      isContractListed={listedTokenIds.has(tokenId)}
      tokenizedAssetProvider={tokenizedAssetProviderByTokenId.get(tokenId)}
      tokenListTags={tokenListTags}
      onImport={onImport}
    />
  )
}
