import { ReactNode } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { getTokenId } from '@cowprotocol/cow-sdk'

import { useAssetVerification } from 'entities/verifiedAsset'

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
  const verification = useAssetVerification(intermediateBuyToken)
  const tokenId = getTokenId(intermediateBuyToken)

  return (
    <AddIntermediateTokenPure
      verification={verification}
      intermediateBuyToken={intermediateBuyToken}
      isContractListed={listedTokenIds.has(tokenId)}
      tokenizedAssetProvider={tokenizedAssetProviderByTokenId.get(tokenId)}
      tokenListTags={tokenListTags}
      onImport={onImport}
    />
  )
}
