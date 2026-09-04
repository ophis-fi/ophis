/**
 * Ophis-branded site header. Used on every route.
 *
 * The right side accepts arbitrary children — the landing supplies its
 * own nav links + Open-Swap button; other routes supply cowswap's
 * NetworkAndAccountControls so users can connect their wallet from
 * within the manual-swap surface.
 */
import { ReactNode } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { Link } from 'react-router'
import styled from 'styled-components/macro'

import { useScrollClass } from '../hooks/useScrollClass'

interface Props {
  children?: ReactNode
  /** Render with a transparent background to overlay the cosmic hero. */
  transparent?: boolean
}

const HeaderStack = styled.div<{ $transparent: boolean }>`
  position: ${({ $transparent }) => ($transparent ? 'absolute' : 'sticky')};
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  width: 100%;
  min-width: 0;
  align-self: stretch;
  box-sizing: border-box;
`

const Announcement = styled.a`
  width: 100%;
  min-height: 38px;
  padding: 8px 20px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #fff;
  background: linear-gradient(90deg, #7b2cff, #c92cf2 48%, #f2a63e);
  font:
    600 13px/1.3 'Geist',
    var(--cow-font-family-primary, system-ui);
  text-align: center;
  text-decoration: none;

  span {
    font-weight: 500;
    white-space: nowrap;
  }

  &:hover span {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -4px;
  }

  @media (max-width: 600px) {
    padding-inline: 12px;
    font-size: 12px;
  }
`

const AnnouncementLogo = styled.img`
  width: 16px;
  height: 21px;
  flex: 0 0 auto;
  filter: drop-shadow(0 1px 3px rgba(33, 0, 52, 0.35));

  @media (max-width: 600px) {
    width: 14px;
    height: 18px;
  }
`

const Bar = styled.header<{ $transparent: boolean }>`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 36px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  background: ${({ $transparent }) => ($transparent ? 'transparent' : 'rgba(2, 0, 13, 0.86)')};
  backdrop-filter: ${({ $transparent }) => ($transparent ? 'none' : 'blur(16px)')};
  border-bottom: 1px solid ${({ $transparent }) => ($transparent ? 'transparent' : 'rgba(245, 239, 230, 0.08)')};
  @media (max-width: 600px) {
    padding: 18px 20px;
  }
`

const Wordmark = styled(Link)`
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.01em;
  color: #f5efe6;
  text-decoration: none;
  user-select: none;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  transition:
    color 140ms ease-out,
    transform 140ms ease-out;
  &:hover {
    color: #ffffff;
  }
  &:hover img {
    transform: rotate(8deg);
  }
`

const Mark = styled.img`
  width: 28px;
  height: 28px;
  display: block;
  transition: transform 280ms cubic-bezier(0.4, 0, 0.2, 1);
`

const WordmarkText = styled.span`
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
`

const WordmarkAccent = styled.span`
  color: #f2a63e;
`

const Right = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
`

const OtcNavLink = styled(Link)`
  padding: 8px 4px;
  color: #f5efe6;
  font:
    600 14px/1 'Geist',
    var(--cow-font-family-primary, system-ui);
  text-decoration: none;
  transition: color 140ms ease-out;

  &:hover,
  &:focus-visible {
    color: #f2a63e;
  }

  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.55);
    outline-offset: 3px;
    border-radius: 4px;
  }
`

export function OphisHeader({ children, transparent = false }: Props): ReactNode {
  const scrolled = useScrollClass(40)
  const { isOtcEnabled } = useFeatureFlags()

  return (
    <HeaderStack $transparent={transparent}>
      <Announcement href="/#/4663/swap" aria-label="Robinhood Chain is live on Ophis. Trade now">
        <AnnouncementLogo src="/robinhood-feather.svg" alt="" aria-hidden="true" />
        Robinhood Chain is live on Ophis. <span>Trade now →</span>
      </Announcement>
      <Bar $transparent={transparent} className={`ophis-header-root${scrolled ? ' scrolled' : ''}`}>
        <Wordmark to="/" aria-label="Ophis, home">
          <Mark src="/ophis-icon.svg" alt="" aria-hidden="true" />
          <WordmarkText>
            ophis<WordmarkAccent>.</WordmarkAccent>
          </WordmarkText>
        </Wordmark>
        <Right>
          {isOtcEnabled ? <OtcNavLink to="/otc">OTC</OtcNavLink> : null}
          {children}
        </Right>
      </Bar>
    </HeaderStack>
  )
}
