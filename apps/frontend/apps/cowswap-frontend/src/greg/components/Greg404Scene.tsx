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
  background: var(
    --greg-gradient-cosmic-radial,
    radial-gradient(120% 100% at 70% 30%, #f4a93b 0%, #9a34c2 20%, #5827e0 45%, #1b0a61 75%, #0a0435 100%)
  );

  &::after {
    /* dark mode dimming layer */
    content: '';
    position: absolute;
    inset: 0;
    background: ${({ theme }) => (theme.darkMode ? 'rgba(0, 0, 0, 0.45)' : 'rgba(0, 0, 0, 0)')};
    pointer-events: none;
  }
`

const Watermark = styled.div`
  /* Large faded Ophie centered behind page content. */
  opacity: 0.16;
  filter: blur(0.5px);
  /* Slight horizontal offset to avoid colliding with the page title visually. */
  transform: translate(0, -4%);
`

/**
 * Full-viewport Ophis 404 scene — cosmic-eclipse radial gradient + low-opacity Ophie watermark.
 *
 * Used by the 404 page via `usePageBackground().setScene(<Greg404Scene />)`.
 * Renders behind the page content (z-index -1, pointer-events: none).
 *
 * Class name kept as `Greg404Scene` (codename); the rendered scene is Ophis.
 */
export function Greg404Scene(): ReactNode {
  return (
    <SceneRoot aria-hidden>
      <Watermark>
        <OphieMark size="min(72vh, 600px)" fill="cream" />
      </Watermark>
    </SceneRoot>
  )
}
