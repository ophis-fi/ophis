import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { OphieMark } from './OphieMark'

const SceneRoot = styled.div`
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--cow-color-background, #ffffff);
  color: var(--cow-color-text, #17191c);
`

const Watermark = styled.div`
  /* Large faded Ophie centered behind page content. */
  opacity: 0.04;
  /* Slight horizontal offset to avoid colliding with the page title visually. */
  transform: translate(0, -4%);
`

/**
 * Full-viewport Ophis 404 scene — neutral canvas and a low-opacity Ophie watermark.
 *
 * Used by the 404 page via `usePageBackground().setScene(<Ophis404Scene />)`.
 * Renders behind the page content (z-index -1, pointer-events: none).
 */
export function Ophis404Scene(): ReactNode {
  return (
    <SceneRoot aria-hidden>
      <Watermark>
        <OphieMark size="min(72vh, 600px)" fill="currentColor" />
      </Watermark>
    </SceneRoot>
  )
}
