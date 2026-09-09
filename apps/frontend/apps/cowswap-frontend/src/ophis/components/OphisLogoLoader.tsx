/**
 * OphisLogoLoader — animated Ophis brand mark (replaces OphisGlobeLoader
 * as the page-level loading indicator).
 *
 * The logo is the ouroboros ring (intent loop) flanked by 4 satellite
 * arrows (4 swap directions). The animation:
 *
 *   - Whole mark rotates slowly (~8s per full rotation) so the satellite
 *     arrows read as orbiting around the ring.
 *   - A subtle scale + opacity pulse (1.00 → 1.04 → 1.00) every 2.2s
 *     adds a "breathing" heartbeat so it doesn't feel static.
 *
 * The external SVG follows the page's ink/paper palette.
 *
 * Respects `prefers-reduced-motion: reduce`.
 */
import { ReactNode } from 'react'

import { getContrastText } from '@cowprotocol/ui-utils'

import styled, { keyframes } from 'styled-components/macro'

interface Props {
  /** Size in px. Default 96. */
  size?: number
  /** ARIA label for screen readers. */
  ariaLabel?: string
  className?: string
}

const rotate = keyframes`
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
`

const breathe = keyframes`
  0%, 100% { transform: scale(1); opacity: 0.7; }
  50%      { transform: scale(1.04); opacity: 1; }
`

const Wrapper = styled.div<{ $size: number }>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  animation: ${breathe} 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
    opacity: 1;
  }
`

const Mark = styled.img`
  width: 100%;
  height: 100%;
  display: block;
  animation: ${rotate} 8s linear infinite;
  filter: ${({ theme }) =>
    getContrastText(theme.background, '#000000') === '#000000' ? 'brightness(0)' : 'brightness(0) invert(1)'};
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

export function OphisLogoLoader({ size = 96, ariaLabel = 'Loading', className }: Props): ReactNode {
  return (
    <Wrapper $size={size} className={className} role="status" aria-label={ariaLabel}>
      <Mark src="/ophis-logo-full.svg" alt="" aria-hidden="true" />
    </Wrapper>
  )
}
