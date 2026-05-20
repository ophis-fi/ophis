import { loadingOpacityMixin, Media, TokenAmount, UI } from '@cowprotocol/ui'

import styled, { css } from 'styled-components/macro'

import Input from 'legacy/components/NumericalInput'

export const OuterWrapper = styled.div`
  max-width: 100%;
  display: flex;
  flex-flow: column wrap;
`

// Ophis: brand-polish the currency-input rows.
// - Bumped radius from 16px → 20px so the rows echo the outer card's
//   xl rhythm and don't feel like generic cowswap rectangles.
// - Hairline border in COLOR_PAPER (1px) so the rows have a clear
//   edge against the card surface, even on the cosmic indigo bg.
// - Focus-within saffron-tinted ring uses COLOR_PRIMARY so the brand
//   coral lights up on input focus.
export const Wrapper = styled.label<{ withReceiveAmountInfo: boolean; readOnly: boolean; pointerDisabled: boolean }>`
  position: relative;
  display: flex;
  flex-flow: row wrap;
  align-content: space-between;
  gap: 10px;
  padding: 16px;
  background: ${({ readOnly }) => (readOnly ? 'transparent' : `var(${UI.COLOR_PAPER_DARKER})`)};
  border: 1px solid var(${UI.COLOR_PAPER});
  border-radius: ${({ withReceiveAmountInfo }) => (withReceiveAmountInfo ? '20px 20px 0 0' : '20px')};
  color: inherit;
  min-height: 106px;
  pointer-events: ${({ pointerDisabled }) => (pointerDisabled ? 'none' : '')};
  max-width: 100%;
  transition: border-color 160ms ease-out, box-shadow 160ms ease-out;

  &:hover {
    border-color: var(${UI.COLOR_PAPER_DARKEST});
  }

  &:focus-within {
    border-color: var(${UI.COLOR_PRIMARY_OPACITY_70});
    box-shadow: 0 0 0 3px var(${UI.COLOR_PRIMARY_OPACITY_10});
  }

  ${({ pointerDisabled }) =>
    pointerDisabled &&
    css`
      &::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        cursor: not-allowed;
        pointer-events: auto;
      }
    `}

  ${Media.upToSmall()} {
    padding: 16px 12px;
  }
`

export const CurrencyInputBox = styled.div<{ isInvalid?: boolean }>`
  display: grid;
  width: 100%;
  grid-template-columns: repeat(2, auto);
  grid-template-rows: max-content;
  word-break: break-all;
  gap: 16px;
  margin: 0;
  font-weight: 400;
  font-size: 13px;
  color: ${({ isInvalid }) => (isInvalid ? `var(${UI.COLOR_RED})` : 'inherit')};

  ${Media.upToSmall()} {
    gap: 8px;
  }

  ${Media.upToTiny()} {
    grid-template-columns: repeat(1, auto);
    grid-template-rows: max-content;
  }

  > div {
    display: flex;
    align-items: center;
    color: inherit;
  }

  > div:last-child {
    text-align: right;
    margin: 0 0 0 auto;
  }
`

export const CurrencyTopLabel = styled.div`
  font-size: 13px;
  font-weight: 400;
  margin: auto 0;
  color: inherit;
  opacity: 0.7;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;

  &:hover {
    opacity: 1;
  }
`

export const TopRow = styled.div`
  display: flex;
  flex-flow: row wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
`

export const NumericalInput = styled(Input)<{ $loading: boolean }>`
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  background: none;
  font-size: 28px;
  font-weight: 500;
  color: inherit;
  text-align: left;

  &::placeholder {
    opacity: 0.7;
    color: inherit;
  }

  ${Media.upToSmall()} {
    font-size: 26px;
    /* F2 (Phase 3.3, 2026-05-20): touch-target minimum on mobile —
     * upstream cowswap renders this at ~35px which is below Apple HIG
     * (44pt) and Material (48dp). 44px keeps thumbs from missing the
     * input on small viewports. Visual font stays at 26px. */
    min-height: 44px;
  }

  ${loadingOpacityMixin}
`

export const TokenAmountStyled = styled(TokenAmount)`
  font-size: 28px;
  font-weight: 500;
  color: inherit;

  ${Media.upToSmall()} {
    font-size: 26px;
  }
`

export const BalanceText = styled.span`
  font-weight: inherit;
  font-size: 13px;
  gap: 5px;
  display: flex;
  align-items: center;
  opacity: 0.7;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;
  color: inherit;

  &:hover {
    opacity: 1;
  }
`

export const FiatAmountText = styled.span`
  // TODO: inherit font styles from 'CurrencyInputBox' instead
  color: inherit;

  > div {
    font-weight: 500;
    font-size: 13px;
    color: inherit;
    transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;
  }
`

export const SetMaxBtn = styled.button`
  display: inline-block;
  cursor: pointer;
  margin: 0;
  background: none;
  border: none;
  outline: none;
  color: inherit;
  font-weight: 600;
  font-size: 11px;
  background: var(${UI.COLOR_PAPER});
  border-radius: 6px;
  padding: 3px 4px;
  text-transform: uppercase;
  white-space: nowrap;
  transition:
    background var(${UI.ANIMATION_DURATION}) ease-in-out,
    color var(${UI.ANIMATION_DURATION}) ease-in-out;

  &:hover {
    background: var(${UI.COLOR_PRIMARY});
    color: var(${UI.COLOR_BUTTON_TEXT});
  }
`
