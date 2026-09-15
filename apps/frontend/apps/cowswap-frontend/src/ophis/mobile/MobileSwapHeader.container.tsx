import { ReactNode } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { Trans } from '@lingui/react/macro'
import { User } from 'react-feather'
import { Link, NavLink } from 'react-router'
import styled from 'styled-components/macro'

import { AccountElement } from 'legacy/components/Header/AccountElement'

import { TradeWidgetLinks } from 'modules/trade'

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  max-width: 1200px;
  padding: 16px 24px;
  margin: 0 auto;
  background: #fff;
  > a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #17191c;
    text-decoration: none;
    font-size: 15px;
  }
  nav {
    display: flex;
    align-items: center;
    gap: 24px;
    margin-right: auto;
    margin-left: 32px;
  }
  nav > div {
    gap: inherit;
  }
  nav a {
    background: transparent;
    border-radius: 0;
    color: #686d78;
    text-decoration: none;
    font-size: 14px;
    padding: 12px 0;
  }
  nav a[aria-current='page'] {
    color: #17191c;
    border-bottom: 1px solid currentColor;
  }
  .profile-link svg {
    display: none;
  }
  @media (max-width: 720px), (pointer: coarse) and (max-height: 500px) {
    max-width: 480px;
    padding: 16px;
    nav {
      margin: 0 0 0 auto;
      gap: 0;
    }
    nav > :not(.profile-link),
    .profile-link span {
      display: none;
    }
    nav .profile-link {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      padding: 0;
    }
    .profile-link svg {
      display: block;
    }
  }
  @media (min-width: 721px) and (max-width: 960px) {
    flex-wrap: wrap;
    nav {
      flex: 1 0 100%;
      order: 3;
      justify-content: center;
      gap: 16px;
      margin: 0;
    }
  }
  > a img {
    width: 24px;
    height: 24px;
  }
`

export function MobileSwapHeader(): ReactNode {
  const { isOtcEnabled } = useFeatureFlags()
  return (
    <Header data-testid="mobile-swap-header">
      <Link to="/">
        <img src="/ophis-icon-mono-dark.svg" alt="" />
        <Trans>Ophis</Trans>
      </Link>
      <nav aria-label="Ophis">
        <TradeWidgetLinks />
        <NavLink to="/profile" className="profile-link" aria-label="Profile">
          <User size={20} aria-hidden="true" />
          <span>
            <Trans>Profile</Trans>
          </span>
        </NavLink>
        {isOtcEnabled && <NavLink to="/otc">OTC</NavLink>}
        <a href="https://explorer.ophis.fi">
          <Trans>Explorer</Trans>
        </a>
      </nav>
      <AccountElement />
    </Header>
  )
}
