/**
 * Styled components for OphisFooter. Extracted to keep the renderer
 * under the AGENTS.md 250-LOC cap.
 *
 * Steep editorial footer: flat paper band, hairline dividers, muted
 * links resolving to ink on hover. No blur, no glow.
 */
import { Link } from 'react-router'
import styled, { css } from 'styled-components/macro'

import { STEEP_FONT, steep } from '../ds/steep.utils'

export const Bar = styled.footer<{ $borderless: boolean }>`
  width: 100%;
  padding: 56px 36px 32px;
  display: flex;
  flex-direction: column;
  gap: 36px;
  font-family: ${STEEP_FONT.body};
  font-size: 14px;
  color: ${({ theme }) => steep(theme).muted};
  background: ${({ theme }) =>
    theme?.darkMode ? 'var(--ophis-steep-dark-bg, #17191c)' : 'var(--ophis-steep-paper, #ffffff)'};
  border-top: 1px solid ${({ theme, $borderless }) => ($borderless ? 'transparent' : steep(theme).cardBorder)};

  @media (max-width: 720px) {
    padding: 40px 20px 24px;
  }
`

// --- Compact variant -------------------------------------------------------
// Slim footer used on viewport-fit routes (the intent landing): brand mark /
// essential links / copyright. ~57px (one row) on desktop; may wrap to two
// centered rows (~90px) on narrow mobile, which is fine — the landing's
// Page uses overflow-y:auto, so a wrapped footer scrolls rather than clips.
export const CompactBar = styled.footer<{ $borderless: boolean }>`
  width: 100%;
  flex: 0 0 auto;
  padding: 14px 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
  flex-wrap: wrap;
  font-family: ${STEEP_FONT.body};
  font-size: 13px;
  color: ${({ theme }) => steep(theme).muted};
  background: ${({ theme }) =>
    theme?.darkMode ? 'var(--ophis-steep-dark-bg, #17191c)' : 'var(--ophis-steep-paper, #ffffff)'};
  border-top: 1px solid ${({ theme, $borderless }) => ($borderless ? 'transparent' : steep(theme).cardBorder)};

  @media (max-width: 600px) {
    padding: 12px 18px;
    justify-content: center;
    gap: 6px 16px;
  }
`

export const CompactBrand = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: ${STEEP_FONT.body};
  font-weight: 600;
  font-size: 15px;
  color: ${({ theme }) => steep(theme).text};
`

export const CompactLinks = styled.nav`
  display: inline-flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  justify-content: center;
`

export const CompactCopy = styled.span`
  font-size: 12px;
  color: ${({ theme }) => steep(theme).muted};
  white-space: nowrap;
`

export const Grid = styled.div`
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr;
  gap: 36px;
  max-width: 1180px;
  width: 100%;
  margin: 0 auto;

  @media (max-width: 1000px) {
    grid-template-columns: 1fr 1fr 1fr;
  }
  @media (max-width: 640px) {
    grid-template-columns: 1fr 1fr;
    gap: 28px 20px;
  }
`

export const Brand = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  grid-column: span 1;

  @media (max-width: 1000px) {
    grid-column: span 3;
  }
  @media (max-width: 640px) {
    grid-column: span 2;
  }
`

export const BrandMark = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: ${STEEP_FONT.body};
  font-weight: 600;
  font-size: 22px;
  color: ${({ theme }) => steep(theme).text};
`

// Wordmark groups "ophis" and its accent period into ONE flex item, so
// BrandMark's 10px gap separates only the icon from the word — not the word
// from its trailing period (which previously rendered as a detached "ophis .").
export const Wordmark = styled.span`
  & span {
    color: ${({ theme }) => steep(theme).text};
  }
`

export const BrandIcon = styled.img`
  width: 28px;
  height: 28px;
  filter: ${({ theme }) => (theme.darkMode ? 'brightness(0) invert(1)' : 'brightness(0)')};
`

export const BrandTagline = styled.p`
  margin: 4px 0 0;
  max-width: 280px;
  font-size: 13px;
  line-height: 1.55;
  color: ${({ theme }) => steep(theme).muted};
`

export const ColTitle = styled.h4`
  margin: 0 0 14px;
  font-family: ${STEEP_FONT.body};
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${({ theme }) => steep(theme).muted};
`

export const ColList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const linkStyles = css`
  color: ${({ theme }) => steep(theme).muted};
  text-decoration: none;
  font-size: 14px;
  transition: color 120ms ease-out;
  &:hover,
  &:focus-visible {
    color: ${({ theme }) => steep(theme).text};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => steep(theme).link};
    outline-offset: 2px;
    border-radius: 2px;
  }
`

export const InternalLink = styled(Link)`
  ${linkStyles}
`

export const ExternalLink = styled.a`
  ${linkStyles}
`

export const BottomBar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding-top: 24px;
  border-top: 1px solid ${({ theme }) => steep(theme).cardBorder};
  font-size: 12px;
  color: ${({ theme }) => steep(theme).muted};
  max-width: 1180px;
  width: 100%;
  margin: 0 auto;
`

export const BottomLinks = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
`

export const SmallLink = styled(Link)`
  color: ${({ theme }) => steep(theme).muted};
  text-decoration: none;
  font-size: 12px;
  &:hover,
  &:focus-visible {
    color: ${({ theme }) => steep(theme).text};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => steep(theme).link};
    outline-offset: 2px;
    border-radius: 2px;
  }
`
