import { ReactNode } from 'react'

import { t } from '@lingui/core/macro'

import { AssetBadgeTooltip } from './AssetBadgeTooltip'

export function CircleBadge({ symbol }: { symbol: string | undefined }): ReactNode {
  const label = t`Official Circle token`
  const stablecoin = symbol === 'USDC' || symbol === 'EURC'
  const description =
    symbol === 'USYC'
      ? t`Contract verified against Circle's registry. USYC requires an eligible, allowlisted wallet.`
      : t`Contract verified against Circle's registry.`

  return <AssetBadgeTooltip label={label} description={description} infoOnly={!stablecoin} />
}
