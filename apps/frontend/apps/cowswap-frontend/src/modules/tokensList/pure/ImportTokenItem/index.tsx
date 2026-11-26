import { ReactNode } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { TokenListTags } from '@cowprotocol/tokens'
import { HoverTooltip } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { CheckCircle } from 'react-feather'

import * as styledEl from './styled'

import { TokenizedAssetProviderTag } from '../../types'
import { ImportButton } from '../commonElements'
import { TokenInfo } from '../TokenInfo'
import { TokenTags } from '../TokenTags'

import type { Verification } from 'entities/verifiedAsset'

export interface ImportTokenItemProps {
  token: TokenWithLogo
  verification?: Verification
  importToken?(token: TokenWithLogo): void
  existing?: true
  shadowed?: boolean
  wrapperId?: string
  isFirstInSection?: boolean
  isLastInSection?: boolean
  disabledReason?: string
  isContractListed: boolean
  tokenizedAssetProvider: TokenizedAssetProviderTag | undefined
  tokenListTags: TokenListTags
}

export function ImportTokenItem(props: ImportTokenItemProps): ReactNode {
  const {
    token,
    verification,
    importToken,
    shadowed,
    existing,
    wrapperId,
    isFirstInSection,
    isLastInSection,
    disabledReason,
    isContractListed,
    tokenizedAssetProvider,
    tokenListTags,
  } = props

  const tokenInfo = (
    <div style={{ opacity: shadowed ? 0.6 : 1 }}>
      <TokenInfo
        token={token}
        verification={verification}
        showAddress={false}
        hideNetworkBadge
        isContractListed={isContractListed}
        tokenizedAssetProvider={tokenizedAssetProvider}
        tags={
          tokenizedAssetProvider && !verification ? (
            <TokenTags
              isUnsupported={false}
              tokenListTags={tokenListTags}
              tokenizedAssetProvider={tokenizedAssetProvider}
            />
          ) : null
        }
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
