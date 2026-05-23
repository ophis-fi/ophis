/**
 * OphisPageLoader — centered Ophis-branded loading shell for
 * route-level Suspense fallbacks.
 *
 * Wraps OphisLogoLoader (the animated brand mark — ouroboros +
 * satellite arrows) with a full-viewport centered layout so lazy-route
 * loads feel intentional and on-brand instead of flashing a generic
 * spinner.
 *
 * Replaced OphisGlobeLoader (d3-geo earth) 2026-05-23 per Clement's
 * "change the animated loader with an animated logo" feedback.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { OphisLogoLoader } from './OphisLogoLoader'

interface Props {
  /** Optional override for the inner mark size in px. Defaults to 120. */
  size?: number
  /** Optional sub-label shown under the loader (e.g. "Loading docs"). */
  label?: string
}

const Outer = styled.div`
  min-height: 70vh;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 48px 16px;
`

const Label = styled.p`
  margin: 0;
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(245, 239, 230, 0.5);
`

export function OphisPageLoader({ size = 120, label }: Props): ReactNode {
  return (
    <Outer>
      <OphisLogoLoader size={size} />
      {label && <Label>{label}</Label>}
    </Outer>
  )
}
