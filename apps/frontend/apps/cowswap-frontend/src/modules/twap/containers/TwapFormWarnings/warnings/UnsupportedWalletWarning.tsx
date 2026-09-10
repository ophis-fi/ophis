import { ReactNode } from 'react'

import { getSafeAccountUrl } from '@cowprotocol/core'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { BannerOrientation, ExternalLink, InlineBanner, StatusColorVariant } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'

import { UNSUPPORTED_WALLET_LINK } from '../../../const'

export interface UnsupportedWalletWarningProps {
  chainId: SupportedChainId
  account?: string
  isSafeViaWc: boolean
}

export function UnsupportedWalletWarning({ isSafeViaWc, chainId, account }: UnsupportedWalletWarningProps): ReactNode {
  if (isSafeViaWc && account) {
    return (
      <InlineBanner bannerType={StatusColorVariant.Info} orientation={BannerOrientation.Horizontal} iconSize={20}>
        <strong>
          <Trans>Use Safe web app</Trans>
        </strong>
        <p>
          <Trans>
            Use the <ExternalLink href={getSafeAccountUrl(chainId, account)}>Safe app</ExternalLink> for advanced
            trading.
          </Trans>
        </p>
      </InlineBanner>
    )
  }

  return (
    <InlineBanner bannerType={StatusColorVariant.Alert} orientation={BannerOrientation.Horizontal} iconSize={20}>
      <strong>
        <Trans>Unsupported wallet detected</Trans>
      </strong>
      <p>
        <Trans>
          TWAP orders currently require a Safe with a special fallback handler. Have one? Switch to it! Need setup?{' '}
          <ExternalLink href={UNSUPPORTED_WALLET_LINK}>Click here</ExternalLink>. Future updates may extend wallet
          support!
        </Trans>
      </p>
      <p>
        <Trans>
          <strong>Note:</strong> If you are using a Safe but still see this message, ensure your Safe is deployed!
        </Trans>
      </p>
    </InlineBanner>
  )
}
