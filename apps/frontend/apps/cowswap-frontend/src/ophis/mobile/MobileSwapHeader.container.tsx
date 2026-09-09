import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { Link } from 'react-router'
import styled from 'styled-components/macro'

import { AccountElement } from 'legacy/components/Header/AccountElement'

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  max-width: 480px;
  padding: 16px;
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
  > a img {
    width: 24px;
    height: 24px;
  }
`

export function MobileSwapHeader(): ReactNode {
  return (
    <Header data-testid="mobile-swap-header">
      <Link to="/">
        <img src="/ophis-icon-mono-dark.svg" alt="" />
        <Trans>Ophis</Trans>
      </Link>
      <AccountElement />
    </Header>
  )
}

const Footer = styled.footer`
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  padding: 12px 24px max(24px, env(safe-area-inset-bottom));
  font-size: 13px;
  color: #777b86;
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
        <Link to="/limit">
          <Trans>Limit</Trans>
        </Link>
        <Link to="/advanced">
          <Trans>Advanced</Trans>
        </Link>
        <Link to="/profile">
          <Trans>Profile</Trans>
        </Link>
      </nav>
    </Footer>
  )
}
