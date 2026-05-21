import { ReactNode } from 'react'

import { BannerOrientation, InlineBanner, StatusColorVariant } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'

export function GuideBanner(): ReactNode {
  return (
    <InlineBanner
      margin="10px"
      width="auto"
      orientation={BannerOrientation.Horizontal}
      bannerType={StatusColorVariant.Info}
    >
      <p>
        <Trans>
          Can't find your token on the list? Paste its contract address into the search box to add it as a custom
          token.
        </Trans>
      </p>
    </InlineBanner>
  )
}
