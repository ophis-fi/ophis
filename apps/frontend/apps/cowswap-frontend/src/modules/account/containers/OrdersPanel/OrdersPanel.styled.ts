import Close from '@cowprotocol/assets/images/x.svg?react'
import { Media, UI } from '@cowprotocol/ui'

import { transparentize } from 'color2k'
import styled from 'styled-components/macro'

import * as accountStyles from '../AccountDetails/styled'

export const SidebarBackground = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  z-index: 99;
  width: 100%;
  height: 100%;
  background: ${({ theme }) => (theme.isWidget ? 'transparent' : transparentize(theme.black, 0.1))};
  backdrop-filter: blur(3px);

  ${Media.upToSmall()} {
    display: none;
    &:has(+ [role='dialog'] [data-swap-receipt]) {
      display: block;
    }
  }
`

export const Header = styled.div`
  width: 100%;
  display: flex;
  justify-content: space-between;
  padding: 20px 30px;
  align-items: center;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;
  color: inherit;
  background: var(${UI.COLOR_PAPER});
  position: sticky;
  top: 0;
  left: 0;
  z-index: 20;

  ${Media.upToMedium()} {
    top: 0;
    padding: 0 16px;
    z-index: 99999;
    position: sticky;
    left: 0;
    height: 52px;
    background: var(${UI.COLOR_PAPER});
  }

  &:hover {
    cursor: pointer;
    opacity: 1;
  }

  > strong {
    font-size: 24px;
    color: inherit;

    ${Media.upToSmall()} {
      font-size: 18px;
    }
  }
`

export const CloseIcon = styled(Close)`
  --size: 20px;
  opacity: 0.6;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;
  color: var(${UI.COLOR_TEXT});
  width: var(--size);
  height: var(--size);
  object-fit: contain;

  &:hover {
    opacity: 1;
  }
`

export const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  cursor: pointer;
`

export const Wrapper = styled.div`
  display: flex;
  flex-flow: row wrap;
  align-items: stretch;
  align-content: flex-start;
  height: inherit;
  width: 100%;
  overflow-y: auto; // fallback for 'overlay'
  overflow-y: overlay;
  ${({ theme }) => theme.colorScrollbar};
`

export const SideBar = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  flex-flow: row wrap;
  position: fixed;
  top: 0;
  right: 0;
  width: 100%;
  max-width: 850px;
  height: 80vh;
  height: 80dvh;
  border-radius: 24px;
  margin: auto;
  bottom: 0;
  left: 0;
  z-index: 100;
  padding: 0;
  cursor: default;
  overflow-y: hidden;
  box-shadow: ${({ theme }) => theme.boxShadow1};
  background: var(${UI.COLOR_PAPER});

  ${Media.upToMedium()} {
    width: 100%;
    height: 100%;
    max-width: 100%;
    border-radius: ${({ theme }) => (theme.isWidget ? '24px' : '0')};
  }

  ${Media.upToSmall()} {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  &:has([data-swap-receipt]) {
    display: block;
    width: min(470px, calc(100% - 24px));
    height: fit-content;
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    border-radius: 20px;

    ${Wrapper}, ${accountStyles.LowerSection} {
      height: auto;
      overflow: visible;
    }

    ${Header} {
      height: auto;
      padding: 4px 12px 0 20px;
    }

    ${Header} > strong {
      font-size: 16px;
    }

    ${accountStyles.Wrapper} {
      padding: 0;
    }

    ${accountStyles.Wrapper} > :not(${accountStyles.LowerSection}), ${accountStyles.LowerSection} > :not([data-swap-receipt]) {
      display: none;
    }

    [data-swap-receipt] {
      border: 0;
      padding-top: 4px;
    }
  }
`
