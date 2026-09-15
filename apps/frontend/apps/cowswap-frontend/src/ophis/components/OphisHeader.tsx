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

import { Link, useLocation } from 'react-router'
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
  min-height: 44px;
  padding: 8px 20px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #5d2a1a;
  background: #fbe1d1;
  font: 600 13px/1.3 ${STEEP_FONT.body};
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
    outline: 2px solid #5d2a1a;
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
  filter: brightness(0);

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

const Wordmark = styled(Link)<{ $transparent: boolean }>`
  font-family: ${STEEP_FONT.body};
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.01em;
  color: ${({ theme, $transparent }) => ($transparent ? '#f4f4f5' : steep(theme).text)};
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
    outline: 2px solid currentColor;
    outline-offset: 3px;
    border-radius: 4px;
  }
`

const Mark = styled.img<{ $transparent: boolean }>`
  width: 28px;
  height: 28px;
  display: block;
  filter: ${({ theme, $transparent }) =>
    theme.darkMode || $transparent ? 'brightness(0) invert(1)' : 'brightness(0)'};
  transition: transform 280ms cubic-bezier(0.4, 0, 0.2, 1);

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`

const WordmarkText = styled.span`
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
`

const WordmarkAccent = styled.span`
  color: inherit;
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

const OtcNavLink = styled(Link)<{ $transparent: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 16px;
  border: 1px solid currentColor;
  border-radius: 12px;
  color: ${({ theme, $transparent }) => ($transparent ? '#f4f4f5' : steep(theme).text)};
  font: 600 14px/1 ${STEEP_FONT.body};
  text-decoration: none;
  transition: background 140ms ease-out;

  &:hover,
  &:focus-visible {
    background: ${({ theme, $transparent }) => ($transparent ? 'rgba(244, 244, 245, 0.08)' : steep(theme).codeBg)};
  }

  &:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
  }
`

export function OphisHeader({ children, transparent = false, walletConnected = false }: Props): ReactNode {
  const isOtcRoute = /^\/otc(?:\/|$)/.test(useLocation().pathname)
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
        <Wordmark to="/" aria-label="Ophis, home" $transparent={transparent}>
          <Mark src="/ophis-icon.svg" alt="" aria-hidden="true" $transparent={transparent} />
          <WordmarkText>
            ophis<WordmarkAccent>.</WordmarkAccent>
          </WordmarkText>
        </Wordmark>
        <Right $walletConnected={walletConnected}>
          {isOtcEnabled && !isOtcRoute ? (
            <OtcNavLink to="/otc" $transparent={transparent}>
              Open OTC
            </OtcNavLink>
          ) : null}
          {children}
        </Right>
      </Bar>
    </HeaderStack>
  )
}
