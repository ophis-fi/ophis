import { ReactNode } from 'react'

import { AssetCheck } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'
import styled from 'styled-components/macro'

import { STOCK_LABELS, isStockIssuer, type Verification } from './verifiedAsset'

const Label = styled.span`
  display: inline-flex;
  align-items: center;
  margin-inline-start: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1;
  vertical-align: middle;
  white-space: nowrap;
  color: var(--cow-color-text);
`

export function VerifiedAssetBadge({ verified }: { verified: Verification | undefined }): ReactNode {
  if (!verified || verified === 'circleSymbol' || verified === 'mismatch') return null
  if (isStockIssuer(verified)) return <Label>{STOCK_LABELS[verified]}</Label>
  const label = verified === 'native' ? t`Native currency` : t`Issued by ${verified}`
  return (
    <Label title={label}>
      <AssetCheck label={label} />
    </Label>
  )
}
