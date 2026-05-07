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
    --greg-gradient-sunset-radial,
    radial-gradient(120% 80% at 20% 20%, #ff8a52 0%, #e66a55 40%, #c73d6c 75%, #5c1d14 100%)
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
 * Full-viewport Greg 404 scene — sunset radial gradient + low-opacity Ophie watermark.
 *
 * Used by the 404 page via `usePageBackground().setScene(<Greg404Scene />)`.
 * Renders behind the page content (z-index -1, pointer-events: none).
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
