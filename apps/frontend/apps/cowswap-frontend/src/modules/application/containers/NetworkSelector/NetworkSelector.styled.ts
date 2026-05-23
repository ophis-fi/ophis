import { Media, UI } from '@cowprotocol/ui'

import { darken, transparentize } from 'color2k'
import { AlertTriangle, ChevronDown, X } from 'react-feather'
import { Link } from 'react-router'
import styled from 'styled-components/macro'

import { TAP_DESKTOP, TAP_MOBILE } from 'common/pure/NetworksList/NetworksList.constants'

const CLOSE_ICON_SIZE = '24px'

// Ophis (2026-05-22): "Cross-chain destinations" footer in the network
// selector dropdown. Solana + Bitcoin are NEAR-Intents bridge destinations
// only — no wallet connect possible. Surfacing here for discoverability;
// actual selection happens in the buy-side token picker. Closes the
// "Solana not in list of networks" UX gap Clement flagged.
export const BridgeDestinationsSection = styled.section`
  border-top: 1px solid var(${UI.COLOR_PAPER_DARKEST});
  padding: 14px 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

export const BridgeDestinationsHeader = styled.div`
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(${UI.COLOR_TEXT_OPACITY_60});
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

export const BridgeDestinationsBadge = styled.span`
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #f2a63e;
  border: 1px solid rgba(242, 166, 62, 0.5);
  border-radius: 4px;
  padding: 2px 6px;
`

export const BridgeDestinationsList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

// react-router Link — handles HashRouter (#/1/swap/_/_) navigation
// natively. Previous `styled.a` with `href="/1/swap/_/_"` triggered a
// non-hash full-page navigation that emergency.js then had to rewrite
// to a hash form, causing a 2-hop redirect or (pre-P0-fix) a silent
// land-on-home. Closes the "clicking Solana/NEAR does nothing"
// regression Clement flagged 2026-05-23.
export const BridgeDestinationRow = styled(Link)`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  text-decoration: none;
  color: var(${UI.COLOR_TEXT});
  font-size: 14px;
  cursor: pointer;
  border: 1px solid transparent;
  transition:
    background-color 160ms ease-out,
    border-color 160ms ease-out,
    transform 160ms cubic-bezier(0.16, 1, 0.3, 1);

  &:hover,
  &:focus-visible {
    background-color: rgba(242, 166, 62, 0.08);
    border-color: rgba(242, 166, 62, 0.3);
    transform: translateX(2px);
  }

  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.5);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: background-color 120ms ease-out;
    &:hover, &:focus-visible {
      transform: none;
    }
  }

  & img {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }

  & .chevron {
    margin-left: auto;
    color: var(${UI.COLOR_TEXT_OPACITY_60});
    font-size: 16px;
    transition: transform 160ms ease-out;
  }
  &:hover .chevron,
  &:focus-visible .chevron {
    color: #f2a63e;
    transform: translateX(2px);
  }
`

export const BridgeDestinationHint = styled.p`
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(${UI.COLOR_TEXT_OPACITY_60});
`

export const FlyoutHeader = styled.div`
  position: sticky;
  top: 0;
  z-index: 1;
  width: 100%;
  padding: 16px 16px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: inherit;
  font-weight: 400;
  background-color: var(${UI.COLOR_PAPER});
  border-bottom: 1px solid var(${UI.COLOR_PAPER_DARKEST});
`

// Ophis: monospace eyebrow tag for the flyout header, in line
// with the brand's "JetBrains Mono labels next to data" treatment.
export const FlyoutHeaderTitle = styled.div`
  flex: 1 1 auto;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(${UI.COLOR_TEXT_OPACITY_70});
  margin: 0;

  ${Media.upToMedium()} {
    font-size: 12px;
  }
`

export const CloseButton = styled.button`
  align-items: center;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: none;
  justify-content: center;
  min-height: ${TAP_DESKTOP};
  min-width: auto;
  object-fit: contain;
  opacity: 0.7;
  padding: 0;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;

  ${Media.upToMedium()} {
    display: inline-flex;
    min-height: ${TAP_MOBILE};
    min-width: auto;
  }

  &:hover {
    opacity: 1;
  }

  &:focus-visible {
    outline: 2px solid var(${UI.COLOR_PRIMARY});
    outline-offset: 2px;
    border-radius: 6px;
  }
`

export const CloseIcon = styled(X)`
  --size: ${CLOSE_ICON_SIZE};
  width: var(--size);
  height: var(--size);

  > line {
    stroke: var(${UI.COLOR_TEXT});
  }
`

export const FlyoutMenu = styled.div`
  ${Media.MediumAndUp()} {
    position: absolute;
    width: 272px;
    z-index: 99;
    padding-top: 10px;
    top: 38px;
    right: 0;
  }
`

// Ophis: chain-selector flyout reads as an Ophis-branded card,
// not a cowswap dropdown. 20px radius (matches input rows), saffron
// hairline at the edge, and a deeper shadow so it lifts off the page.
export const FlyoutMenuContents = styled.div.attrs(() => ({
  role: 'dialog',
  'aria-modal': true,
}))`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  overflow: hidden;
  background-color: var(${UI.COLOR_PAPER});
  border: 1px solid var(${UI.COLOR_PAPER_DARKEST});
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 18px 40px rgba(0, 0, 0, 0.55),
    0 4px 12px rgba(0, 0, 0, 0.32);
  border-radius: 20px;
  font-size: 16px;
  min-width: 220px;
  z-index: 99;
  max-height: calc(100dvh - 66px - 32px);

  ${Media.upToMedium()} {
    bottom: 56px;
    left: 0;
    position: fixed;
    width: 100%;
    border-radius: 20px 20px 0 0;
    box-shadow: 0 -100vh 0 100vh ${transparentize('black', 0.5)};
    max-height: calc(100dvh - 56px) !important;
  }
`

export const FlyoutMenuScrollable = styled.div`
  overflow: auto;
  width: 100%;

  ${({ theme }) => theme.colorScrollbar};

  ${Media.upToMedium()} {
    padding: 0 0 100px;
  }
`

export const FlayoutMenuList = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 0 16px 16px;
`

export const SelectorLabel = styled.div`
  display: block;
  flex: 1 1 auto;
  margin: 0;
  white-space: nowrap;

  ${Media.upToExtraSmall()} {
    display: none;
  }
`
export const SelectorControls = styled.div<{ $isChainIdUnsupported: boolean; $isOpen: boolean }>`
  align-items: center;
  color: inherit;
  display: flex;
  font-weight: 400;
  justify-content: space-between;
  gap: 6px;
  border-radius: 28px;
  border: 2px solid transparent;
  padding: 6px;
  transition: border var(${UI.ANIMATION_DURATION}) ease-in-out;
  background: transparent;

  ${({ $isOpen }) =>
    $isOpen &&
    `
      background: var(${UI.COLOR_PAPER_DARKER});
      border: 2px solid var(${UI.COLOR_PAPER_DARKEST});
    `}

  &:focus {
    background-color: ${({ theme }) => darken(theme.error, 0.1)};
  }

  &:hover {
    border: 2px solid ${({ theme }) => transparentize(theme.text, 0.7)};
  }

  ${({ $isChainIdUnsupported, theme }) =>
    $isChainIdUnsupported &&
    `
      color: ${theme.danger}!important;
      background: ${transparentize(theme.danger, 0.85)}!important;
      border: 2px solid ${transparentize(theme.danger, 0.5)}!important;
    `}
`
export const SelectorLogo = styled.img<{ interactive?: boolean }>`
  --size: 24px;
  width: var(--size);
  height: var(--size);
  margin-right: ${({ interactive }) => (interactive ? 8 : 0)}px;
  object-fit: contain;

  ${Media.upToExtraSmall()} {
    --size: 21px;
  }
`
export const SelectorWrapper = styled.div`
  display: flex;
  cursor: pointer;
  height: 100%;

  ${Media.MediumAndUp()} {
    position: relative;
  }
`
export const StyledChevronDown = styled(ChevronDown)<{ $isOpen: boolean }>`
  width: 21px;
  height: 21px;
  margin: 0 0 0 -3px;
  object-fit: contain;
  transform: ${({ $isOpen }) => ($isOpen ? 'rotate(180deg)' : 'rotate(0deg)')};
  transition: transform var(${UI.ANIMATION_DURATION}) ease-in-out;
`
export const NetworkIcon = styled(AlertTriangle)`
  margin-left: 0.25rem;
  margin-right: 0.25rem;
  width: 16px;
  height: 16px;
`
export const NetworkAlertLabel = styled.div`
  flex: 1 1 auto;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: 0 0.5rem 0 0.4rem;
  font-size: 1rem;
  width: fit-content;
  font-weight: 500;

  ${Media.upToExtraSmall()} {
    > span {
      display: none;
    }
  }
`
