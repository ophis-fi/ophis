/**
 * Section — a labeled content band inside a PageShell.
 *
 * Provides H2 + optional intro + body slot. Use for major content units
 * within a long-form page (Terms / Privacy / Mission / Protocol explainer).
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

interface SectionProps {
  /** Anchor id for in-page TOC links. */
  id?: string
  /** Section heading, renders as H2 in Fraunces. */
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
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: clamp(24px, 3vw, 32px);
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: #f5efe6;
`

const Intro = styled.p`
  margin: 0 0 20px;
  color: rgba(245, 239, 230, 0.75);
  font-size: 16px;
  line-height: 1.6;
`

/**
 * Body — scoped to DIRECT child paragraphs only. Codex PR #246 audit
 * caught that `& p` (descendant) would leak into FeatureCard,
 * MetricCard, Callout, table cells, etc. once those primitives are
 * used inside Sections. `& > p` keeps the prose styling local.
 */
const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;

  & > p {
    margin: 0;
    color: rgba(245, 239, 230, 0.78);
    line-height: 1.7;
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
