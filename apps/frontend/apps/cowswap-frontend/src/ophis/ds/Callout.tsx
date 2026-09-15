/**
 * Callout — visually-distinct banner for important info, warnings, or
 * status notices. Replaces the bespoke `Note` styled-components every
 * page was re-defining locally.
 *
 * Variants follow the same tone vocabulary as `Badge` — keep them in sync.
 * `planned` renders on the Steep peach accent; other tones use restrained
 * tinted fills that hold text contrast.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { STEEP_FONT, steep, type SteepToneName } from './steep.utils'

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'planned'

interface CalloutProps {
  className?: string
  tone?: CalloutTone
  /** Optional title. Renders bold above the body. */
  title?: ReactNode
  children: ReactNode
}

const Outer = styled.aside<{ $tone: CalloutTone }>`
  border: 1px solid;
  border-radius: 16px;
  padding: 18px 20px;
  font-size: 14px;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: ${({ theme, $tone }) => steep(theme).tones[$tone as SteepToneName].text};
  border-color: ${({ theme, $tone }) => steep(theme).tones[$tone as SteepToneName].border};
  background: ${({ theme, $tone }) => steep(theme).tones[$tone as SteepToneName].bg};
`

const Title = styled.div`
  font-family: ${STEEP_FONT.body};
  font-weight: 600;
  font-size: 15px;
  letter-spacing: -0.005em;
`

const Body = styled.div`
  & > ul,
  & > ol {
    margin: 8px 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  & p {
    margin: 0;
  }
  & p + p {
    margin-top: 8px;
  }
  /* Space an action button (e.g. the Connect Wallet CTA on Profile/Rewards)
     from the paragraph above it; the paragraph's margin is zeroed above. */
  & p + button {
    margin-top: 18px;
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

export function Callout({ tone = 'info', title, children, role, className }: CalloutPropsWithRole): ReactNode {
  return (
    <Outer $tone={tone} role={role} className={className}>
      {title && <Title>{title}</Title>}
      <Body>{children}</Body>
    </Outer>
  )
}
