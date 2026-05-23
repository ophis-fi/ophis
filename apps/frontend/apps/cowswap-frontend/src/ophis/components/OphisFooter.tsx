/**
 * Ophis-branded site footer. Used on every route.
 */
import { ReactNode } from 'react'

import { Link } from 'react-router'
import styled from 'styled-components/macro'

interface Props {
  /** Render with no top border for routes where the body already has its own divider. */
  borderless?: boolean
}

const Bar = styled.footer<{ $borderless: boolean }>`
  width: 100%;
  padding: 28px 36px 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 13px;
  color: rgba(245, 239, 230, 0.5);
  background: rgba(2, 0, 13, 0.86);
  border-top: 1px solid ${({ $borderless }) => ($borderless ? 'transparent' : 'rgba(245, 239, 230, 0.08)')};
  @media (max-width: 600px) {
    padding: 22px 20px 26px;
    font-size: 12px;
  }
`

const Left = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 12px;
`

const Right = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
`

const ExternalLink = styled.a`
  color: rgba(245, 239, 230, 0.55);
  text-decoration: none;
  &:hover {
    color: rgba(245, 239, 230, 0.85);
  }
`

const InternalLink = styled(Link)`
  color: rgba(245, 239, 230, 0.55);
  text-decoration: none;
  &:hover {
    color: rgba(245, 239, 230, 0.85);
  }
`

export function OphisFooter({ borderless = false }: Props): ReactNode {
  return (
    <Bar $borderless={borderless}>
      <Left>© Ophis 2026</Left>
      <Right>
        <InternalLink to="/">Home</InternalLink>
        <InternalLink to="/1/swap/_/_">Trade</InternalLink>
        <ExternalLink href="/docs">Docs</ExternalLink>
        <InternalLink to="/faq">FAQ</InternalLink>
        <InternalLink to="/about">About</InternalLink>
        <InternalLink to="/institutional">Institutional</InternalLink>
        <InternalLink to="/tiers">Tiers</InternalLink>
        <InternalLink to="/profile">Profile</InternalLink>
        <InternalLink to="/missions">Missions</InternalLink>
        <InternalLink to="/brand">Brand</InternalLink>
        <InternalLink to="/legal">Legal</InternalLink>
        <ExternalLink href="https://github.com/ophis-fi/ophis" target="_blank" rel="noreferrer">
          GitHub
        </ExternalLink>
      </Right>
    </Bar>
  )
}
