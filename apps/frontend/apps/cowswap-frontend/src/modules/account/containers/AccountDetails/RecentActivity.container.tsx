import { Fragment, lazy, ReactNode, Suspense } from 'react'

import { CHAIN_INFO } from '@cowprotocol/common-const'
import { getExplorerAddressLink } from '@cowprotocol/common-utils'
import { ExternalLink } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { i18n } from '@lingui/core'
import { Trans } from '@lingui/react/macro'

import { groupActivitiesByDay, useMultipleActivityDescriptors } from 'legacy/hooks/useRecentActivity'

import { ActivitiesList } from './ActivitiesList'
import * as styledEl from './styled'

import { CreationDateText } from '../Transaction/styled'

const NativeSolanaHistory = lazy(() =>
  import('modules/nativeSolana').then((module) => ({ default: module.NativeSolanaHistory })),
)

interface RecentActivityProps {
  evmAccount: string | undefined
  pendingTransactions: string[]
  confirmedTransactions: string[]
  solanaOwner: string | undefined
}

export function RecentActivity({
  evmAccount,
  pendingTransactions,
  confirmedTransactions,
  solanaOwner,
}: RecentActivityProps): ReactNode {
  const { chainId } = useWalletInfo()
  const activities = useMultipleActivityDescriptors({ chainId, ids: pendingTransactions.concat(confirmedTransactions) })
  const count = evmAccount ? activities.length : 0
  const explorer = evmAccount && getExplorerAddressLink(chainId, evmAccount)

  return (
    <styledEl.LowerSection as="section" aria-labelledby="recent-account-activity">
      <span>
        <h5 id="recent-account-activity">
          <Trans>Recent Activity</Trans> {!!count && !solanaOwner && <span>({count})</span>}
        </h5>
        {explorer && !!count && !solanaOwner && (
          <ExternalLink href={explorer}>
            <Trans>View all orders</Trans> ↗
          </ExternalLink>
        )}
      </span>
      {solanaOwner && (
        <Suspense fallback={null}>
          <NativeSolanaHistory key={solanaOwner} />
        </Suspense>
      )}
      {!!count && (
        <div>
          {solanaOwner && (
            <h3>
              {CHAIN_INFO[chainId].label} ({count})
            </h3>
          )}
          {groupActivitiesByDay(activities).map(({ date, activities }) => (
            <Fragment key={date.getTime()}>
              <CreationDateText>{date.toLocaleString(i18n.locale, { dateStyle: 'long' })}</CreationDateText>
              <ActivitiesList activities={activities} />
            </Fragment>
          ))}
          {explorer && (
            <ExternalLink href={explorer}>
              <Trans>View all orders</Trans> ↗
            </ExternalLink>
          )}
        </div>
      )}
      {!count && !solanaOwner && (
        <styledEl.NoActivityMessage>
          <Trans>Your activity will appear here...</Trans>
        </styledEl.NoActivityMessage>
      )}
    </styledEl.LowerSection>
  )
}
