/**
 * Section — a labeled content band inside a PageShell.
 *
 * Provides H2 + optional intro + body slot. Use for major content units
 * within a long-form page (Terms / Privacy / Mission / Protocol explainer).
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { STEEP_FONT, steep } from './steep.utils'

interface SectionProps {
  /** Anchor id for in-page TOC links. */
  id?: string
  /** Section heading, renders as H2 in Georgia regular. */
  title: ReactNode
  /** Optional one-line intro under the H2. */
  intro?: ReactNode
  /** Section body — text, lists, tables, callouts, etc. */
  children: ReactNode
}

const Outer = styled.section`
  scroll-margin-top: 90px; /* Account for sticky header when anchored. */
`

const Heading = styled.h2`
  margin: 0 0 12px;
  font-family: ${STEEP_FONT.display};
  font-weight: 400;
  font-size: clamp(28px, 3vw, 34px);
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: ${({ theme }) => steep(theme).text};
`

const Intro = styled.p`
  margin: 0 0 20px;
  color: ${({ theme }) => steep(theme).secondary};
  font-size: 16px;
  line-height: 1.6;
`

/**
 * Body — scoped to DIRECT children only. Codex PR #246 audit caught
 * that `& p` (descendant) would leak into FeatureCard, MetricCard,
 * Callout, table cells, etc. once those primitives are used inside
 * Sections. `& >` keeps the prose styling local.
 */
const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;

  & > p {
    margin: 0;
    color: ${({ theme }) => steep(theme).text};
    line-height: 1.7;
  }

  & > h3 {
    margin: 8px 0 0;
    font-family: ${STEEP_FONT.display};
    font-weight: 400;
    font-size: 22px;
    line-height: 1.3;
    letter-spacing: -0.01em;
    color: ${({ theme }) => steep(theme).text};
  }

  & > ul,
  & > ol {
    margin: 0;
    padding-left: 22px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: ${({ theme }) => steep(theme).text};
    line-height: 1.65;
  }

  & strong {
    font-weight: 600;
    color: ${({ theme }) => steep(theme).text};
  }
`

export function Section({ id, title, intro, children }: SectionProps): ReactNode {
  return (
    <Outer id={id}>
      <Heading>{title}</Heading>
      {intro && <Intro>{intro}</Intro>}
      <Body>{children}</Body>
    </Outer>
  )
}
