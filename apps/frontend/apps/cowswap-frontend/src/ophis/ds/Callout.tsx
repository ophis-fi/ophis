/**
 * Callout — visually-distinct banner for important info, warnings, or
 * status notices. Replaces the bespoke `Note` styled-components every
 * page was re-defining locally.
 *
 * Variants follow the same tone vocabulary as `Badge` — keep them in sync.
 */
import { ReactNode } from 'react'

import styled, { css } from 'styled-components/macro'

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'planned'

interface CalloutProps {
  tone?: CalloutTone
  /** Optional title. Renders bold above the body. */
  title?: ReactNode
  children: ReactNode
}

const TONE_STYLES: Record<CalloutTone, ReturnType<typeof css>> = {
  info: css`
    border-color: rgba(180, 138, 255, 0.35);
    background: rgba(180, 138, 255, 0.06);
    --callout-accent: #b48aff;
  `,
  success: css`
    border-color: rgba(109, 207, 161, 0.4);
    background: rgba(109, 207, 161, 0.06);
    --callout-accent: #6dcfa1;
  `,
  warning: css`
    border-color: rgba(255, 187, 110, 0.45);
    background: rgba(255, 187, 110, 0.06);
    --callout-accent: #ffbb6e;
  `,
  danger: css`
    border-color: rgba(255, 140, 140, 0.45);
    background: rgba(255, 140, 140, 0.06);
    --callout-accent: #ff8c8c;
  `,
  planned: css`
    border-color: rgba(242, 166, 62, 0.4);
    background: rgba(242, 166, 62, 0.08);
    --callout-accent: #f2a63e;
  `,
}

const Outer = styled.aside<{ $tone: CalloutTone }>`
  border: 1px solid;
  border-radius: 12px;
  padding: 16px 18px;
  font-size: 14px;
  line-height: 1.6;
  color: rgba(245, 239, 230, 0.85);
  display: flex;
  flex-direction: column;
  gap: 6px;
  ${({ $tone }) => TONE_STYLES[$tone]}
`

const Title = styled.div`
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: 16px;
  color: var(--callout-accent);
  letter-spacing: -0.005em;
`

const Body = styled.div`
  & p {
    margin: 0;
  }
  & p + p {
    margin-top: 8px;
  }
`

interface CalloutPropsWithRole extends CalloutProps {
  /**
   * Override the ARIA role. Default is none (static content). Set to
   * `'alert'` only for REAL runtime alerts that need screen-reader
   * interruption (e.g. a live "transaction failed" notice). For static
   * legal/status content leave unset.
   *
   * Codex PR #246 audit: role="alert" on static warning callouts was too
   * aggressive — screen readers would interrupt the user for static page
   * content. Now opt-in.
   */
  role?: 'alert' | 'status' | 'note'
}

export function Callout({
  tone = 'info',
  title,
  children,
  role,
}: CalloutPropsWithRole): ReactNode {
  return (
    <Outer $tone={tone} role={role}>
      {title && <Title>{title}</Title>}
      <Body>{children}</Body>
    </Outer>
  )
}
