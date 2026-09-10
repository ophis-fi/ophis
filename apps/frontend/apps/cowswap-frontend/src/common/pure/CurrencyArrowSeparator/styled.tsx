import { UI } from '@cowprotocol/ui'

import { ArrowDown } from 'react-feather'
import styled, { css } from 'styled-components/macro'

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

export const LoadingWrapper = styled.button`
  --size: 32px;

  position: absolute;
  left: calc(50% - var(--size) / 2);
  top: 0;
  bottom: 0;
  height: var(--size);
  text-align: center;
  transition:
    background 160ms ease-out,
    border-color 160ms ease-out;
  border: 1px solid var(${UI.COLOR_BORDER});
  box-shadow: 0 0 0 4px var(${UI.COLOR_PAPER});
  background: var(${UI.COLOR_PAPER});
  color: var(${UI.COLOR_TEXT_PAPER});
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

  &:not(:disabled):hover {
    background: var(${UI.COLOR_PAPER_DARKER});
  }

  &:focus-visible {
    outline: 2px solid var(${UI.COLOR_TEXT_PAPER});
    outline-offset: 4px;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
  ${({ theme }) =>
    theme.isOphisMobileSwap &&
    css`
      --size: 44px;
      border: 4px solid #fff;
      box-shadow: none;
      background: #f2f2f3;
      &:not(:disabled):hover {
        transform: none;
        box-shadow: none;
        background: #e8e8ea;
        color: #17191c;
      }
    `}
`

export const ArrowDownIcon = styled(ArrowDown)<{ disabled: boolean }>`
  display: block;
  margin: auto;
  stroke: currentColor;
  stroke-width: 2px;
  padding: 0;
  height: 100%;
  width: 20px;
  cursor: inherit;
  color: inherit;
`
