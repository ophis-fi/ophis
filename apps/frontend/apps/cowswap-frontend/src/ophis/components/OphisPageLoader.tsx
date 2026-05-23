/**
 * OphisPageLoader — centered Ophis-branded loading shell for
 * route-level Suspense fallbacks.
 *
 * Replaces the legacy cowswap `Loading` (FlashingLoading) component
 * used in the SPA Suspense fallback. Wraps OphisGlobeLoader with a
 * full-viewport centered layout so lazy-route loads feel intentional
 * and on-brand instead of flashing a generic spinner.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { OphisGlobeLoader } from './OphisGlobeLoader'

interface Props {
  /** Optional override for the inner globe size in px. Defaults to 120. */
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
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(245, 239, 230, 0.5);
`

export function OphisPageLoader({ size = 120, label }: Props): ReactNode {
  return (
    <Outer>
      <OphisGlobeLoader size={size} />
      {label && <Label>{label}</Label>}
    </Outer>
  )
}
