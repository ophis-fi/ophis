/**
 * PageShell — the standard wrapper for content pages (About, Legal, Brand,
 * Institutional, Tiers, Profile, Missions, Earn, Learn, Protocol).
 *
 * Does NOT render OphisHeader / OphisFooter — those come from
 * AppContainer.container.tsx. PageShell only owns the inner content layout.
 *
 * Variants:
 *   - `narrow` (default, ~720px): long-form legal/about pages
 *   - `medium` (~960px): institutional + dashboard-style pages
 *   - `wide` (~1200px): brand kit, dashboards, learn hub
 *
 * Built for Phase A of the 2026-05-23 design system rebuild — see Codex
 * design-partner review in `docs/development/specs/2026-05-23-ophis-ds-phase-a-plan.md`.
 */
import { ReactNode } from 'react'

import styled, { css } from 'styled-components/macro'

export type PageWidth = 'narrow' | 'medium' | 'wide'

interface PageShellProps {
  width?: PageWidth
  /** Optional eyebrow text shown above the title in monospace caps. */
  eyebrow?: ReactNode
  /** Main page title. Renders in Fraunces. */
  title?: ReactNode
  /** Lede paragraph below the title, in italic sunset color. */
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
  color: #f5efe6;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
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
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(245, 239, 230, 0.6);
`

const titleStyles = css`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: clamp(36px, 5vw, 56px);
  line-height: 1.05;
  letter-spacing: -0.015em;
  color: #f5efe6;
  margin: 0;
`

const Title = styled.h1`
  ${titleStyles}
`

const Lede = styled.p`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-size: 20px;
  font-style: italic;
  color: #f2a63e;
  margin: 16px 0 40px;
  max-width: 620px;
  line-height: 1.5;
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 48px;
`

export function PageShell({
  width = 'narrow',
  eyebrow,
  title,
  lede,
  children,
}: PageShellProps): ReactNode {
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
