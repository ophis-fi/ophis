import { UI } from '@cowprotocol/ui'

import { ArrowDown } from 'react-feather'
import styled, { css } from 'styled-components/macro'

import { loadingAnimationMixin } from './style-mixins'

export const Box = styled.div<{
  isCollapsed: boolean
  hasSeparatorLine?: boolean
}>`
  display: block;
  margin: ${({ isCollapsed }) => (isCollapsed ? '-13px auto' : '2px auto')};
  color: inherit;
  position: relative;
  z-index: 2;
  width: 100%;
  height: 26px;
  justify-content: center;
  transition: width var(${UI.ANIMATION_DURATION}) ease-in-out;
  pointer-events: none;

  ${({ hasSeparatorLine }) =>
    hasSeparatorLine &&
    css`
      &::before {
        content: '';
        position: absolute;
        width: calc(100% + 16px);
        left: -8px;
        top: calc(50% - 1px);
        height: 1px;
        background: var(${UI.COLOR_PAPER_DARKER});
      }
    `}
`

// Ophis: pill-shaped arrow swap button (32px round disc) that
// punches through the seam between the two input rows. Card bg as
// the disc surface (so it sits on a "puck" of card colour), with a
// brand coral border by default — the affordance is loud, not shy.
export const LoadingWrapper = styled.button<{ $isLoading: boolean }>`
  --size: 32px;

  position: absolute;
  left: calc(50% - var(--size) / 2);
  top: 0;
  bottom: 0;
  height: var(--size);
  text-align: center;
  transform-style: preserve-3d;
  transform-origin: center right;
  transition: transform 0.25s ease-out, box-shadow 160ms ease-out, background 160ms ease-out, border-color 160ms ease-out;
  border: 1.5px solid var(${UI.COLOR_PRIMARY});
  box-shadow: 0 0 0 4px var(${UI.COLOR_PAPER}), 0 6px 18px rgba(0, 0, 0, 0.45);
  background: var(${UI.COLOR_PAPER});
  color: var(${UI.COLOR_PRIMARY});
  border-radius: 50%;
  width: var(--size);
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;

  /* F2 (Phase 3.3 mobile UX, 2026-05-20): visual disc stays at 32px but
   * tap area extends to 44px on mobile to meet Apple HIG / Material
   * touch-target minimums. The ::before invisible expander adds 6px on
   * each side without affecting layout. */
  &::before {
    content: '';
    position: absolute;
    inset: -6px;
    z-index: -1;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  ${({ $isLoading }) =>
    $isLoading
      ? loadingAnimationMixin
      : css`
          &:not(:disabled):hover {
            transform: translateY(-2px) rotate(180deg);
            background: var(${UI.COLOR_PRIMARY});
            color: var(${UI.COLOR_PAPER});
            box-shadow:
              0 0 0 4px var(${UI.COLOR_PAPER}),
              0 0 0 6px var(${UI.COLOR_PRIMARY_OPACITY_25}),
              0 6px 18px rgba(0, 0, 0, 0.45);
          }
        `}
`

export const ArrowDownIcon = styled(ArrowDown)<{ disabled: boolean }>`
  display: block;
  margin: auto;
  stroke: currentColor;
  stroke-width: 3px;
  padding: 0;
  height: 100%;
  width: 20px;
  cursor: inherit;
  color: inherit;
`
