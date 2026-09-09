import { UI, Media } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

export const EditIcon = styled.div`
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(${UI.COLOR_TEXT});

  > svg > path {
    fill: currentColor;
  }
`

export const ToggleWrapper = styled.div`
  display: flex;
  justify-content: space-between;
  border-radius: 12px;
  background: var(${UI.COLOR_BACKGROUND});
  color: var(${UI.COLOR_TEXT_PAPER});
  min-height: 58px;

  ${Media.upToTiny()} {
    flex-flow: column wrap;
  }
`

export const OptionWrapper = styled.button<{ isActive?: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: 9px;
  margin: 4px;
  padding: 8px 4px;
  flex: 1 1 50%;
  line-height: 1;
  font-size: 12px;
  cursor: ${({ isActive }) => (isActive ? 'default' : 'pointer')};
  color: ${({ isActive }) => (isActive ? `var(${UI.COLOR_TEXT})` : `var(${UI.COLOR_TEXT_OPACITY_70})`)};
  background: ${({ isActive }) => (isActive ? `var(${UI.COLOR_PAPER})` : 'transparent')};
`

export const PartialAmountWrapper = styled.div<{ isActive?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: fit-content;
  border-radius: 9px;
  font-size: 12px;
  letter-spacing: -0.3px;
  padding: 3px 7px;
  margin: 0 auto;
  cursor: ${({ isActive }) => (isActive ? 'default' : 'pointer')};
  background: var(${UI.COLOR_INFO_BG});
  transition:
    background var(${UI.ANIMATION_DURATION}) ease-in-out,
    color var(${UI.ANIMATION_DURATION}) ease-in-out;

  &:hover {
    background: var(${UI.COLOR_PRIMARY_LIGHTER});
    color: var(${UI.COLOR_PAPER});

    ${EditIcon} {
      color: var(${UI.COLOR_PAPER});
    }
  }
`

export const OptionTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: inherit;
`

export const SpendingLimit = styled.section`
  background: #fbe1d1;
  color: #5d2a1a;
  border-radius: 24px;
  padding: 24px 16px 16px;
  text-align: center;
  > h3 {
    font-size: 11px;
    line-height: 1.4;
    font-weight: 500;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    margin: 0 0 14px;
  }
  > p {
    font-size: 13px;
    line-height: 1.6;
    margin: 12px 0 0;
  }
  > button {
    background: transparent;
    color: inherit;
    border: none;
    text-decoration: underline;
    text-underline-offset: 4px;
    cursor: pointer;
  }
`

export const SpendingAmount = styled.div`
  font-family: var(--ophis-font-body);
  font-size: clamp(24px, 7vw, 32px);
  font-weight: 400;
  font-variant-numeric: lining-nums tabular-nums;
  line-height: 1.2;
  overflow-wrap: anywhere;
`

export const ApprovalOptions = styled.details`
  font-size: 13px;
  > summary {
    cursor: pointer;
    padding: 14px 0;
  }
`
