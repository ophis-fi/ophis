import { ReactNode, useCallback } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { getTokenId } from '@cowprotocol/cow-sdk'

import * as styledEl from './styled'

import { useAddTokenImportCallback } from '../../hooks/useAddTokenImportCallback'
import { useConfiguredTokenListDisplayMetadata } from '../../hooks/useConfiguredTokenListDisplayMetadata'
import { ImportTokenItem } from '../ImportTokenItem'

interface AddIntermediateTokenProps {
  intermediateBuyToken: TokenWithLogo
  onImport: () => void
}

export function AddIntermediateToken({ intermediateBuyToken, onImport }: AddIntermediateTokenProps): ReactNode {
  const addTokenImportCallback = useAddTokenImportCallback()
  const { verifiedTokenIds, tokenizedAssetProviderByTokenId } = useConfiguredTokenListDisplayMetadata(
    intermediateBuyToken.chainId,
  )
  const tokenId = getTokenId(intermediateBuyToken)

  const handleImport = useCallback(
    (token: TokenWithLogo) => {
      addTokenImportCallback(token)
      onImport()
    },
    [onImport, addTokenImportCallback],
  )

  return (
    <styledEl.AddIntermediateTokenWrapper>
      <ImportTokenItem
        key={tokenId}
        token={intermediateBuyToken}
        importToken={handleImport}
        isContractVerified={verifiedTokenIds.has(tokenId)}
        tokenizedAssetProvider={tokenizedAssetProviderByTokenId.get(tokenId)}
      />
    </styledEl.AddIntermediateTokenWrapper>
  )
}
