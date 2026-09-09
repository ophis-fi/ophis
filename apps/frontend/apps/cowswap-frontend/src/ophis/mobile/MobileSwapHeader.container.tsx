import { ReactNode } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { Trans } from '@lingui/react/macro'
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
  @media (max-width: 720px), (pointer: coarse) and (max-height: 500px) {
    max-width: 480px;
    padding: 16px;
    nav {
      display: none;
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
        <NavLink to="/profile">
          <Trans>Profile</Trans>
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

const Footer = styled.footer`
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 12px 24px max(24px, env(safe-area-inset-bottom));
  font-size: 13px;
  color: #5b606b;
  @media (max-width: 720px) {
    max-width: 480px;
  }
  summary {
    cursor: pointer;
    padding: 14px 0;
  }
  p {
    line-height: 1.6;
  }
  a {
    color: inherit;
    text-underline-offset: 4px;
  }
  nav {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 24px;
    padding: 20px 0;
    border-top: 1px solid #e8e8ea;
  }
`

export function MobileSwapFooter(): ReactNode {
  return (
    <Footer>
      <details>
        <summary>
          <Trans>Refer friends</Trans>
        </summary>
        <p>
          <Trans>Share Ophis and track your referrals from your profile.</Trans>{' '}
          <Link to="/profile">
            <Trans>View profile</Trans> →
          </Link>
        </p>
      </details>
      <nav aria-label="More from Ophis">
        <TradeWidgetLinks />
        <Link to="/profile">
          <Trans>Profile</Trans>
        </Link>
      </nav>
    </Footer>
  )
}
