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

import { STEEP_FONT, steep } from '../ds/steep.utils'
import { useScrollClass } from '../hooks/useScrollClass'

interface Props {
  children?: ReactNode
  /** Render with a transparent background to overlay a hero. */
  transparent?: boolean
  walletConnected?: boolean
}

const HeaderStack = styled.div<{ $transparent: boolean }>`
  position: ${({ $transparent }) => ($transparent ? 'absolute' : 'sticky')};
  top: 0;
  left: 0;
  right: 0;
  && {
    z-index: 2;
  }
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

const Bar = styled.header<{ $transparent: boolean; $walletConnected: boolean }>`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 36px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-family: ${STEEP_FONT.body};
  background: ${({ theme, $transparent }) =>
    $transparent
      ? 'transparent'
      : theme?.darkMode
        ? 'var(--ophis-steep-dark-bg, #17191c)'
        : 'var(--ophis-steep-paper, #ffffff)'};
  border-bottom: 1px solid ${({ theme, $transparent }) => ($transparent ? 'transparent' : steep(theme).cardBorder)};
  @media (max-width: 600px) {
    padding: 12px 16px;
    flex-wrap: wrap;
    gap: 12px;
    ${({ $walletConnected }) => $walletConnected && 'display: grid; grid-template-columns: 1fr auto;'}
  }
`

const Wordmark = styled(Link)`
  font-family: ${STEEP_FONT.body};
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.01em;
  color: ${({ theme }) => steep(theme).text};
  text-decoration: none;
  user-select: none;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  transition: color 140ms ease-out;
  &:hover img {
    transform: rotate(8deg);
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => steep(theme).link};
    outline-offset: 3px;
    border-radius: 4px;
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
  color: ${({ theme }) => steep(theme).text};
`

const Right = styled.div<{ $walletConnected: boolean }>`
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  margin-left: auto;

  @media (max-width: 600px) {
    ${({ $walletConnected }) => $walletConnected && 'display: contents;'}
  }
`

const OtcNavLink = styled(Link)`
  padding: 8px 4px;
  color: ${({ theme }) => steep(theme).muted};
  font: 600 14px/1 ${STEEP_FONT.body};
  text-decoration: none;
  transition: color 140ms ease-out;

  &:hover,
  &:focus-visible {
    color: ${({ theme }) => steep(theme).text};
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => steep(theme).link};
    outline-offset: 3px;
    border-radius: 4px;
  }
`

export function OphisHeader({ children, transparent = false, walletConnected = false }: Props): ReactNode {
  const scrolled = useScrollClass(40)
  const { isOtcEnabled } = useFeatureFlags()

  return (
    <HeaderStack $transparent={transparent}>
      <Announcement href="/#/4663/swap" aria-label="Robinhood Chain is live on Ophis. Trade now">
        <AnnouncementLogo src="/robinhood-feather.svg" alt="" aria-hidden="true" />
        Robinhood Chain is live on Ophis. <span>Trade now →</span>
      </Announcement>
      <Bar
        $transparent={transparent}
        $walletConnected={walletConnected}
        className={`ophis-header-root${scrolled ? ' scrolled' : ''}`}
      >
        <Wordmark to="/" aria-label="Ophis, home">
          <Mark src="/ophis-icon.svg" alt="" aria-hidden="true" />
          <WordmarkText>
            ophis<WordmarkAccent>.</WordmarkAccent>
          </WordmarkText>
        </Wordmark>
        <Right $walletConnected={walletConnected}>
          {isOtcEnabled ? <OtcNavLink to="/otc">OTC</OtcNavLink> : null}
          {children}
        </Right>
      </Bar>
    </HeaderStack>
  )
}
