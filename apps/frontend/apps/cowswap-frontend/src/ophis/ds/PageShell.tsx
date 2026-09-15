/**
 * PageShell — the standard wrapper for content pages (About, Legal, Brand,
 * Institutional, Tiers, Profile, Missions, Earn, Learn, Protocol).
 *
 * Does NOT render OphisHeader / OphisFooter — those come from
 * AppContainer.container.tsx. PageShell only owns the inner content layout.
 * It also does NOT paint a page background: the shell (AppContainer) owns
 * the canvas, so this stays transparent and only sets ink + type.
 *
 * Variants:
 *   - `narrow` (default, ~720px): long-form legal/about pages
 *   - `medium` (~960px): institutional + dashboard-style pages
 *   - `wide` (~1200px): brand kit, dashboards, learn hub
 *
 * Steep editorial system: Georgia regular headings, Inter/system body,
 * ink-on-paper light default with a neutral-ink dark variant selected
 * via theme.darkMode.
 */
import { ReactNode } from 'react'

import styled, { css } from 'styled-components/macro'

import { STEEP_FONT, steep } from './steep.utils'

export type PageWidth = 'narrow' | 'medium' | 'wide'

interface PageShellProps {
  width?: PageWidth
  /** Optional eyebrow text shown above the title in small caps. */
  eyebrow?: ReactNode
  /** Main page title. Renders in Georgia regular. */
  title?: ReactNode
  /** Lede paragraph below the title, in muted slate. */
  lede?: ReactNode
  /** Page body — Sections, Callouts, etc. */
  children: ReactNode
}

const WIDTH_MAP: Record<PageWidth, string> = {
  narrow: '720px',
  medium: '960px',
  wide: '1200px',
}

const Outer = styled.main`
  width: 100%;
  display: flex;
  flex-direction: column;
  color: ${({ theme }) => steep(theme).text};
  font-family: ${STEEP_FONT.body};
  font-size: 16px;
  line-height: 1.65;
`

const Inner = styled.div<{ $width: PageWidth }>`
  width: 100%;
  max-width: ${({ $width }) => WIDTH_MAP[$width]};
  margin: 0 auto;
  padding: 64px 24px 96px;

  @media (max-width: 600px) {
    padding: 32px 18px 56px;
  }
`

const Eyebrow = styled.p`
  margin: 0 0 12px;
  font-family: ${STEEP_FONT.body};
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${({ theme }) => steep(theme).muted};
`

const titleStyles = css`
  font-family: ${STEEP_FONT.display};
  font-weight: 400;
  font-size: clamp(36px, 5vw, 56px);
  line-height: 1.15;
  letter-spacing: -0.015em;
  color: ${({ theme }) => steep(theme).text};
  margin: 0;
`

const Title = styled.h1`
  ${titleStyles}
`

const Lede = styled.p`
  font-family: ${STEEP_FONT.body};
  font-size: 18px;
  line-height: 1.5;
  color: ${({ theme }) => steep(theme).secondary};
  margin: 16px 0 40px;
  max-width: 620px;
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 48px;
`

export function PageShell({ width = 'narrow', eyebrow, title, lede, children }: PageShellProps): ReactNode {
  return (
    <Outer>
      <Inner $width={width}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        {title && <Title>{title}</Title>}
        {lede && <Lede>{lede}</Lede>}
        <Body>{children}</Body>
      </Inner>
    </Outer>
  )
}
