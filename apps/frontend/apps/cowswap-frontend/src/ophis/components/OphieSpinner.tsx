import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { OphieMark } from './OphieMark'

const Wrapper = styled.div<{ $size: number }>`
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: var(--ophis-space-3, 12px);
  width: ${({ $size }) => $size}px;
`

const Caption = styled.span`
  font-family: var(--ophis-font-body);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--cow-color-text-opacity-70);
  text-align: center;
`

export interface OphieSpinnerProps {
  /** Size of the Ophie mark in pixels. Default 96. */
  size?: number
  /** Optional caption rendered below the mark in Plus Jakarta. */
  caption?: ReactNode
  /** Animation pace. "fast" for active loading, "slow" for ambient. Default "fast". */
  pace?: 'fast' | 'slow'
}

/**
 * Ophis's branded loading state — Ophie rotating with an optional caption.
 *
 * Use for full-page or section-level loads where the visual identity matters
 * (initial app boot, swap quote refresh on an empty surface, settings sheet
 * lazy-load). Existing skeleton/shimmer placeholders inside the swap widget
 * stay as-is — they're better at communicating partial load.
 */
export function OphieSpinner({ size = 96, caption, pace = 'fast' }: OphieSpinnerProps): ReactNode {
  return (
    <Wrapper $size={size}>
      <OphieMark size={size} fill="coral" animate={pace === 'fast' ? 'spin-fast' : 'spin'} />
      {caption && <Caption>{caption}</Caption>}
    </Wrapper>
  )
}
