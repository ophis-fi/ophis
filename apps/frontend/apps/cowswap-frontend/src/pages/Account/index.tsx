import { ReactNode } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { t } from '@lingui/core/macro'
import { Outlet, useLocation } from 'react-router'

import { Content, Title } from 'modules/application'

import { Routes as RoutesEnum } from 'common/constants/routes'

import { AccountMenu } from './Menu'
import { AccountPageWrapper, Wrapper } from './Tokens/styled'

// The legacy "Account overview" dashboard (Balances/Governance/Delegate) was
// entirely CoW-DAO/token UI — COW/vCOW balances + conversion, voting on CoW
// proposals, delegating (v)COW. Ophis has no governance token, so it was
// removed; `/account` now redirects to the Tokens overview (see RoutesApp).
function getPropsFromRoute(route: string, isAffiliateProgramEnabled: boolean): string[] {
  switch (route) {
    case RoutesEnum.ACCOUNT_TOKENS:
      return ['account-tokens', t`Tokens overview`]
    case RoutesEnum.ACCOUNT_AFFILIATE_TRADER:
      return isAffiliateProgramEnabled ? ['account-my-rewards', t`Rewards hub - My Rewards`] : []
    default:
      return []
  }
}

export default function Account(): ReactNode {
  const { pathname } = useLocation()
  const { isAffiliateProgramEnabled } = useFeatureFlags()
  const [id, name] = getPropsFromRoute(pathname, isAffiliateProgramEnabled)
  return (
    <Wrapper>
      <AccountMenu />
      <AccountPageWrapper>
        <Content>
          <Title id={id}>{name}</Title>
          <Outlet />
        </Content>
      </AccountPageWrapper>
    </Wrapper>
  )
}
