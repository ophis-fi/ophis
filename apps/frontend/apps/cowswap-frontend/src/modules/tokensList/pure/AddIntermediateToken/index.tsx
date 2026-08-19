import { ReactNode, useCallback } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { getTokenId } from '@cowprotocol/cow-sdk'
import { TokenListTags } from '@cowprotocol/tokens'

import * as styledEl from './styled'

import { useAddTokenImportCallback } from '../../hooks/useAddTokenImportCallback'
import { TokenizedAssetProviderTag } from '../../types'
import { ImportTokenItem } from '../ImportTokenItem'

interface AddIntermediateTokenProps {
  intermediateBuyToken: TokenWithLogo
  isContractListed: boolean
  tokenizedAssetProvider: TokenizedAssetProviderTag | undefined
  tokenListTags: TokenListTags
  onImport: () => void
}

export function AddIntermediateToken({
  intermediateBuyToken,
  isContractListed,
  tokenizedAssetProvider,
  tokenListTags,
  onImport,
}: AddIntermediateTokenProps): ReactNode {
  const addTokenImportCallback = useAddTokenImportCallback()
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
        isContractListed={isContractListed}
        tokenizedAssetProvider={tokenizedAssetProvider}
        tokenListTags={tokenListTags}
      />
    </styledEl.AddIntermediateTokenWrapper>
  )
}
