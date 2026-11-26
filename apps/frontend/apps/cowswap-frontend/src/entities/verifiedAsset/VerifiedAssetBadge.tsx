import { ReactNode } from 'react'

import { t } from '@lingui/core/macro'
import { CheckCircle } from 'react-feather'
import styled from 'styled-components/macro'

import { STOCK_LABELS, isStockIssuer, type Verification } from './verifiedAsset'

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-inline-start: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1;
  vertical-align: middle;
  white-space: nowrap;
  color: var(--cow-color-text);
  svg {
    color: #2775ca;
    flex-shrink: 0;
  }
`

export function VerifiedAssetBadge({ verified }: { verified: Verification | undefined }): ReactNode {
  if (!verified || verified === 'circleSymbol' || verified === 'mismatch') return null
  const issuer = isStockIssuer(verified) ? STOCK_LABELS[verified] : undefined
  const source = isStockIssuer(verified)
    ? STOCK_LABELS[verified]
    : {
        native: t`Native currency`,
        wrappedSol: t`Wrapped SOL`,
        circle: 'Circle',
        tether: 'Tether',
        usdt0: 'USDT0',
        binancePegUsdc: 'Binance-Peg USDC',
        binancePegUsdt: 'Binance-Peg USDT',
        bridgedUsdc: t`Bridged USDC`,
        bridgedUsdt: t`Bridged USDT`,
      }[verified]
  const label = t`Verified asset · ${source}`
  return (
    <Badge title={label} role="img" aria-label={label}>
      <CheckCircle size={14} strokeWidth={2.5} aria-hidden="true" />
      {issuer}
    </Badge>
  )
}
