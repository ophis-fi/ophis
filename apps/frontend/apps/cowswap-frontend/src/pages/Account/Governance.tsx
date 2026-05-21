import { Trans } from '@lingui/react/macro'

import { DELEGATE_URL } from './constants'
import { ExtLink, BannerCard, BannerCardContent, CardActions, BannerCardTitle } from './styled'

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default function Governance() {
  return (
    <BannerCard>
      <BannerCardContent fontSize="14px">
        <BannerCardTitle fontSize={24}>
          <Trans>Governance</Trans>
        </BannerCardTitle>
        <small>
          <Trans>Use your (v)COW balance to vote on important proposals or participate in forum discussions.</Trans>
        </small>
        <CardActions content="flex-start">
          <ExtLink href={'https://snapshot.org/#/cow.eth'}>
            <Trans>View proposals</Trans> ↗
          </ExtLink>
          {/*
            F9 rebrand sweep (2026-05-21): removed Forum link to
            https://forum.cow.fi/ — Ophis has no equivalent community
            forum. The surrounding Governance page is itself
            CoW-DAO-specific (vCOW + Snapshot space cow.eth) and is a
            candidate for future removal.
          */}
          <ExtLink href={DELEGATE_URL}>
            <Trans>Delegate (v)COW</Trans> ↗
          </ExtLink>
        </CardActions>
      </BannerCardContent>
    </BannerCard>
  )
}
