import { Media, UI } from '@cowprotocol/ui'

import { transparentize } from 'color2k'
import styled from 'styled-components/macro'

import {
  ROW_HEIGHT_DESKTOP,
  ROW_HEIGHT_MOBILE,
  NETWORK_ICON_SIZE_MOBILE,
  NETWORK_ICON_SIZE_DESKTOP,
} from './NetworksList.constants'

export const Logo = styled.img`
  --size: ${NETWORK_ICON_SIZE_DESKTOP};
  width: var(--size);
  height: var(--size);
  margin-right: 8px;

  ${Media.upToMedium()} {
    --size: ${NETWORK_ICON_SIZE_MOBILE};
  }
`

export const NetworkLabel = styled.div`
  flex: 1 1 auto;
  margin: 0 auto 0 8px;
  font-size: 15px;

  ${Media.upToMedium()} {
    font-weight: 500;
    font-size: 16px;
  }
`

// Greg/Ophis: chain rows get a 12px radius (matches Ophis chip rhythm)
// and a saffron-tinted active background instead of the cowswap blue
// `theme.bg2`. Active row uses COLOR_PRIMARY_OPACITY_10 so the
// selected chain reads as "lit by the brand".
export const FlyoutRow = styled.button<{ $active: boolean }>`
  align-items: center;
  background-color: ${({ $active }) => ($active ? `var(${UI.COLOR_PRIMARY_OPACITY_10})` : 'transparent')};
  border-radius: 12px;
  border: 1px solid ${({ $active }) => ($active ? `var(${UI.COLOR_PRIMARY_OPACITY_25})` : 'transparent')};
  cursor: pointer;
  display: flex;
  font-weight: 500;
  justify-content: space-between;
  padding: 8px 10px;
  text-align: left;
  width: 100%;
  color: ${({ $active }) => ($active ? `var(${UI.COLOR_PRIMARY})` : `var(${UI.COLOR_TEXT})`)};
  appearance: none;

  &:hover {
    color: ${({ $active, theme }) => ($active ? `var(${UI.COLOR_PRIMARY})` : theme.text1)};
    background: ${({ theme, $active }) =>
      $active ? `var(${UI.COLOR_PRIMARY_OPACITY_25})` : transparentize(theme.text, 0.9)};
    border-color: ${({ $active }) => ($active ? `var(${UI.COLOR_PRIMARY})` : 'transparent')};
  }

  &:focus-visible {
    outline: 2px solid var(${UI.COLOR_PRIMARY});
    outline-offset: 2px;
  }

  ${Media.MediumAndUp()} {
    min-height: ${ROW_HEIGHT_DESKTOP};
    height: ${ROW_HEIGHT_DESKTOP};
  }

  ${Media.upToMedium()} {
    min-height: ${ROW_HEIGHT_MOBILE};
    height: ${ROW_HEIGHT_MOBILE};
  }

  transition: background 0.16s ease-in-out, border-color 0.16s ease-in-out;
`

// Active-row dot: brand coral when selected, muted lavender-grey when
// idle — matches the dark cosmic palette.
export const FlyoutRowActiveIndicator = styled.div<{ $active: boolean }>`
  background-color: ${({ $active }) => ($active ? `var(${UI.COLOR_PRIMARY})` : 'rgba(168, 162, 184, 0.6)')};
  box-shadow: ${({ $active }) => ($active ? `0 0 0 3px var(${UI.COLOR_PRIMARY_OPACITY_25})` : 'none')};
  border-radius: 50%;
  height: 8px;
  width: 8px;
  transition: background-color 0.16s ease-in-out, box-shadow 0.16s ease-in-out;
`

// Greg/Ophis: active chain always at the top of the list (mobile and
// desktop) — users want to see what they're currently on, not hunt
// through an alphabetical list to find it.
export const ActiveRowWrapper = styled.div`
  background-color: var(${UI.COLOR_PAPER_DARKER});
  border-radius: 12px;
  border: 1px solid var(${UI.COLOR_PAPER_DARKEST});
  width: 100%;
  padding: 8px;
  margin: 12px 0;
  order: -1;

  ${Media.upToMedium()} {
    padding: 0;
  }
`
