import { ReactNode } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { HoverTooltip } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { CheckCircle } from 'react-feather'

import * as styledEl from './styled'

import { TokenizedAssetProviderTag } from '../../types'
import { ImportButton } from '../commonElements'
import { TokenInfo } from '../TokenInfo'

export interface ImportTokenItemProps {
  token: TokenWithLogo
  importToken?(token: TokenWithLogo): void
  existing?: true
  shadowed?: boolean
  wrapperId?: string
  isFirstInSection?: boolean
  isLastInSection?: boolean
  disabledReason?: string
  isContractVerified?: boolean
  tokenizedAssetProvider?: TokenizedAssetProviderTag
}

export function ImportTokenItem(props: ImportTokenItemProps): ReactNode {
  const {
    token,
    importToken,
    shadowed,
    existing,
    wrapperId,
    isFirstInSection,
    isLastInSection,
    disabledReason,
    isContractVerified,
    tokenizedAssetProvider,
  } = props

  const tokenInfo = (
    <div style={{ opacity: shadowed ? 0.6 : 1 }}>
      <TokenInfo
        token={token}
        showAddress={false}
        hideNetworkBadge
        isContractVerified={isContractVerified}
        tokenizedAssetProvider={tokenizedAssetProvider}
      />
    </div>
  )

  return (
    <styledEl.Wrapper id={wrapperId} $isFirst={isFirstInSection} $isLast={isLastInSection}>
      {disabledReason ? (
        <HoverTooltip wrapInContainer placement="top" content={disabledReason}>
          {tokenInfo}
        </HoverTooltip>
      ) : (
        tokenInfo
      )}
      <div>
        {existing && (
          <styledEl.ActiveToken>
            <CheckCircle size={16} strokeWidth={2} />
            <span>
              <Trans>Active</Trans>
            </span>
          </styledEl.ActiveToken>
        )}
        {importToken && (
          <ImportButton onClick={() => importToken(token)}>
            <Trans>Import</Trans>
          </ImportButton>
        )}
      </div>
    </styledEl.Wrapper>
  )
}
