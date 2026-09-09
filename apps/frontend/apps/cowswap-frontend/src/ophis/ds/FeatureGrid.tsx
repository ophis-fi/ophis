/**
 * FeatureGrid / FeatureCard — repeated feature or value list.
 *
 * Use for Institutional "why desks use us" panels, About "how it works"
 * 3-up cards, Brand kit color/font cards, Tiers ladder, Missions list.
 *
 * Grid is auto-responsive via `minmax(min(<minCardWidth>, 100%), 1fr)`
 * so cards reflow on narrow viewports without bleeding off the side.
 *
 * FeatureCard is composable — accepts heading, body, optional icon and
 * optional footer (badge/link/CTA). Cards are flat mist surfaces —
 * no lift, no shadow.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { STEEP_FONT, steep } from './steep.utils'

interface FeatureGridProps {
  /** Minimum card width before wrapping. Default 260px. */
  minCardWidth?: string
  /** Gap between cards. Default 16px. */
  gap?: string
  children: ReactNode
}

const Grid = styled.div<{ $minCardWidth: string; $gap: string }>`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(${({ $minCardWidth }) => $minCardWidth}, 100%), 1fr));
  gap: ${({ $gap }) => $gap};
`

export function FeatureGrid({ minCardWidth = '260px', gap = '16px', children }: FeatureGridProps): ReactNode {
  return (
    <Grid $minCardWidth={minCardWidth} $gap={gap}>
      {children}
    </Grid>
  )
}

interface FeatureCardProps {
  /** Optional icon / step numeral / small illustration above the heading. */
  icon?: ReactNode
  /** Card heading. Renders as h3 in sans medium. */
  title: ReactNode
  /** Card body — paragraph(s) or short list. */
  children: ReactNode
  /** Optional footer row — Badge, TextLink, CTA, etc. */
  footer?: ReactNode
}

const Card = styled.article`
  border-radius: 20px;
  padding: 24px 22px;
  background: ${({ theme }) => (theme?.darkMode ? steep(theme).card : 'var(--ophis-steep-mist, #f2f2f3)')};
  border: 1px solid ${({ theme }) => (theme?.darkMode ? steep(theme).cardBorder : 'transparent')};
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition:
    border-color 180ms ease-out,
    background-color 180ms ease-out;

  &:hover {
    border-color: ${({ theme }) => steep(theme).hoverBorder};
  }
`

const Icon = styled.div`
  font-family: ${STEEP_FONT.display};
  font-style: italic;
  font-size: 22px;
  line-height: 1;
  color: ${({ theme }) => steep(theme).secondary};
`

const Title = styled.h3`
  margin: 0;
  font-family: ${STEEP_FONT.body};
  font-weight: 500;
  font-size: 18px;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: ${({ theme }) => steep(theme).text};
`

const Body = styled.div`
  color: ${({ theme }) => steep(theme).muted};
  font-size: 14px;
  line-height: 1.6;

  & > p {
    margin: 0;
  }
  & > p + p {
    margin-top: 8px;
  }
`

const Footer = styled.div`
  margin-top: auto;
  padding-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

export function FeatureCard({ icon, title, children, footer }: FeatureCardProps): ReactNode {
  return (
    <Card>
      {icon && <Icon>{icon}</Icon>}
      <Title>{title}</Title>
      <Body>{children}</Body>
      {footer && <Footer>{footer}</Footer>}
    </Card>
  )
}
