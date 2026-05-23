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
 * The SVG is loaded as <img> (from /ophis-logo-full.svg) for simplicity;
 * sunset color is applied via CSS filter rather than fill-currentColor
 * to keep this file slim (the raw SVG path is 11 KB).
 *
 * Respects `prefers-reduced-motion: reduce`.
 */
import { ReactNode } from 'react'

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

/* Filter chain converts black SVG to saffron #f2a63e. Computed via
   color-matrix; alternative would be inlining the SVG and using
   fill="currentColor", but the path is ~11 KB so we keep it external. */
const Mark = styled.img`
  width: 100%;
  height: 100%;
  display: block;
  animation: ${rotate} 8s linear infinite;
  filter: brightness(0) saturate(100%) invert(75%) sepia(60%) saturate(550%)
    hue-rotate(345deg) brightness(95%) contrast(95%);
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

export function OphisLogoLoader({
  size = 96,
  ariaLabel = 'Loading',
  className,
}: Props): ReactNode {
  return (
    <Wrapper $size={size} className={className} role="status" aria-label={ariaLabel}>
      <Mark src="/ophis-logo-full.svg" alt="" aria-hidden="true" />
    </Wrapper>
  )
}
