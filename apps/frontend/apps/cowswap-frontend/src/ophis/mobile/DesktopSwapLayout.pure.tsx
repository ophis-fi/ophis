import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import styled from 'styled-components/macro'

import { MobileSwapHeading } from './MobileSwapHeading.pure'

const Layout = styled.div`
  width: 100%;
  max-width: 1200px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 560px);
  gap: 64px;
  padding: 32px 8px;
  align-items: start;
  > div {
    min-width: 0;
  }
  @media (max-width: 720px), (pointer: coarse) and (max-height: 500px) {
    display: block;
    padding: 0;
    > aside {
      display: none;
    }
  }
  @media (min-width: 721px) and (max-width: 960px) {
    max-width: 560px;
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
    > aside {
      padding: 0;
    }
    > aside h1 {
      text-align: center;
      margin: 0;
      font-size: 44px;
    }
    > aside p,
    > aside ul {
      display: none;
    }
  }
`
const Introduction = styled.aside`
  padding-top: 24px;
  h1 {
    font-size: clamp(44px, 5vw, 64px);
    text-align: left;
    line-height: 1.2;
    margin-top: 0;
  }
  p {
    color: #686d78;
    font-size: 17px;
    line-height: 1.6;
    max-width: 38ch;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 28px 0;
    border-top: 1px solid #e8e8ea;
  }
  li {
    padding: 18px 0;
    border-bottom: 1px solid #e8e8ea;
    font-size: 14px;
    line-height: 1.6;
    color: #686d78;
  }
  strong {
    color: #17191c;
    font-weight: 500;
  }
`

export function DesktopSwapLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <Layout>
      <Introduction>
        <MobileSwapHeading />
        <p>
          <Trans>Choose your tokens. Review your limits. Make your next move.</Trans>
        </p>
        <ul>
          <li>
            <strong>
              <Trans>Choose what to receive.</Trans>
            </strong>{' '}
            <Trans>Find the asset on the right network.</Trans>
          </li>
          <li>
            <strong>
              <Trans>Review the details.</Trans>
            </strong>{' '}
            <Trans>Amounts, fees, and destination, together.</Trans>
          </li>
          <li>
            <strong>
              <Trans>Set the spending limit.</Trans>
            </strong>{' '}
            <Trans>Check the exact approval before signing.</Trans>
          </li>
        </ul>
      </Introduction>
      <div>{children}</div>
    </Layout>
  )
}
