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
