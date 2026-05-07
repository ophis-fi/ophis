import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

export const Tabs = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: center;
  margin: 16px 0 10px;
  border-bottom: 1px solid var(${UI.COLOR_TEXT_OPACITY_10});
`

// Greg/Nucleus: active tab uses brand (coral) instead of CoW info-blue, bold weight, brand underline.
export const Tab = styled.button<{ $active: boolean }>`
  background: none;
  margin: 0;
  outline: none;
  border: 0;
  cursor: pointer;
  color: ${({ $active }) => ($active ? 'var(' + UI.COLOR_PRIMARY + ')' : 'var(' + UI.COLOR_TEXT + ')')};
  opacity: ${({ $active }) => ($active ? 1 : 0.6)};
  padding: var(--greg-space-3, 12px) var(--greg-space-4, 16px);
  font-family: var(--greg-font-body);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-decoration: none;
  text-align: center;
  position: relative;
  transition: all var(${UI.ANIMATION_DURATION_SLOW}) ease-in-out;
  border-radius: var(--greg-radius-sm, 4px);
  flex: 1 1 auto;

  &::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    width: 100%;
    height: 2px;
    background-color: var(${UI.COLOR_PRIMARY});
    opacity: ${({ $active }) => ($active ? 1 : 0)};
    transition: all var(${UI.ANIMATION_DURATION_SLOW}) ease-in-out;
  }

  &:hover {
    opacity: 1;
    background-color: var(${UI.COLOR_PRIMARY_OPACITY_10});
  }

  &:disabled {
    cursor: default;
  }
`
