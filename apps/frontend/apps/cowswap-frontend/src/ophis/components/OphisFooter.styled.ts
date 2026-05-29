/**
 * Styled components for OphisFooter. Extracted to keep the renderer
 * under the AGENTS.md 250-LOC cap.
 */
import { Link } from 'react-router'
import styled, { css } from 'styled-components/macro'

export const Bar = styled.footer<{ $borderless: boolean }>`
  width: 100%;
  padding: 56px 36px 32px;
  display: flex;
  flex-direction: column;
  gap: 36px;
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 14px;
  color: rgba(245, 239, 230, 0.6);
  background: rgba(2, 0, 13, 0.86);
  border-top: 1px solid ${({ $borderless }) => ($borderless ? 'transparent' : 'rgba(245, 239, 230, 0.08)')};

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
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 13px;
  color: rgba(245, 239, 230, 0.6);
  /* More-opaque dark backing (0.72) gives the footer text a reliable dark
     surface over the bright hero behind it, so the copyright/links clear
     WCAG-AA contrast regardless of what hue sits behind the translucent bar. */
  background: rgba(2, 0, 13, 0.72);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border-top: 1px solid ${({ $borderless }) => ($borderless ? 'transparent' : 'rgba(245, 239, 230, 0.08)')};

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
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-weight: 600;
  font-size: 15px;
  color: #f5efe6;
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
  /* 0.6 (was 0.42) over the 0.72 dark bar clears WCAG-AA 4.5:1 for the
     12px copyright line. Review finding LOW#2. */
  color: rgba(245, 239, 230, 0.6);
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
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-weight: 600;
  font-size: 22px;
  color: #f5efe6;
`

// Wordmark groups "ophis" and its accent period into ONE flex item, so
// BrandMark's 10px gap separates only the icon from the word — not the word
// from its trailing period (which previously rendered as a detached "ophis .").
export const Wordmark = styled.span`
  & span {
    color: #f2a63e;
  }
`

export const BrandIcon = styled.img`
  width: 28px;
  height: 28px;
`

export const BrandTagline = styled.p`
  margin: 4px 0 0;
  max-width: 280px;
  font-size: 13px;
  line-height: 1.55;
  color: rgba(245, 239, 230, 0.55);
`

export const ColTitle = styled.h4`
  margin: 0 0 14px;
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(245, 239, 230, 0.45);
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
  color: rgba(245, 239, 230, 0.7);
  text-decoration: none;
  font-size: 14px;
  transition: color 120ms ease-out;
  &:hover,
  &:focus-visible {
    color: #f5efe6;
  }
  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.5);
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
  border-top: 1px solid rgba(245, 239, 230, 0.06);
  font-size: 12px;
  color: rgba(245, 239, 230, 0.45);
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
  color: rgba(245, 239, 230, 0.5);
  text-decoration: none;
  font-size: 12px;
  &:hover,
  &:focus-visible {
    color: rgba(245, 239, 230, 0.85);
  }
  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.5);
    outline-offset: 2px;
    border-radius: 2px;
  }
`
