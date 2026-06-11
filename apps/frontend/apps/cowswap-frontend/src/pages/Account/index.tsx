import { ReactNode } from 'react'

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
function getPropsFromRoute(route: string): string[] {
  switch (route) {
    case RoutesEnum.ACCOUNT_TOKENS:
      return ['account-tokens', t`Tokens overview`]
    default:
      return []
  }
}

export default function Account(): ReactNode {
  const { pathname } = useLocation()
  const [id, name] = getPropsFromRoute(pathname)
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
