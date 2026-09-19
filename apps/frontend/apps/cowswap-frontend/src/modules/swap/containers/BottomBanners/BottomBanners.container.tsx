import { ReactNode } from 'react'

import HAND_SVG from '@cowprotocol/assets/cow-swap/hand.svg'
import { BannerOrientation, InlineBanner, StatusColorVariant } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans } from '@lingui/react/macro'
import { ArrowRight, Gift } from 'react-feather'
import { Link } from 'react-router'

import { getProxyAccountUrl } from 'modules/accountProxy/utils/getProxyAccountUrl'
import { useIsHooksTradeType } from 'modules/trade'

import { useIsProviderNetworkDeprecated } from 'common/hooks/useIsProviderNetworkDeprecated'

import * as styledEl from './BottomBanners.styled'

import { DeprecatedNetworkBanner } from '../DeprecatedNetworkBanner/DeprecatedNetworkBanner.container'
import { NetworkBridgeBanner } from '../NetworkBridgeBanner/NetworkBridgeBanner.container'

export function BottomBanners(): ReactNode {
  const { chainId, account } = useWalletInfo()
  const isProviderNetworkDeprecated = useIsProviderNetworkDeprecated()
  const isHookTradeType = useIsHooksTradeType()
  const accountProxyUrl = getProxyAccountUrl(chainId, 'hooks')

  let bannerNode: ReactNode | null = null

  if (isProviderNetworkDeprecated) {
    bannerNode = <DeprecatedNetworkBanner />
  } else if (isHookTradeType && account) {
    bannerNode = (
      <InlineBanner
        bannerType={StatusColorVariant.Info}
        customIcon={HAND_SVG}
        iconSize={24}
        orientation={BannerOrientation.Horizontal}
        backDropBlur
        margin="10px auto auto"
      >
        <Trans>
          Funds stuck? <Link to={accountProxyUrl}>Recover your funds</Link>
        </Trans>
      </InlineBanner>
    )
  } else {
    bannerNode = <NetworkBridgeBanner />
  }

  return (
    <styledEl.Wrapper>
      <styledEl.Giveaway to="/rewards">
        <strong>
          <Gift size={20} aria-hidden="true" />
          <Trans>Swap $100+. Get a ticket.</Trans>
        </strong>
        <p>
          <Trans>Win 1 or 10 USDG on Robinhood Chain.</Trans>
        </p>
        <small>
          <Trans>One per eligible wallet. While rewards last.</Trans>
        </small>
        <span>
          <Trans>Claim your ticket</Trans>
          <ArrowRight size={16} aria-hidden="true" />
        </span>
      </styledEl.Giveaway>
      {bannerNode}
    </styledEl.Wrapper>
  )
}
