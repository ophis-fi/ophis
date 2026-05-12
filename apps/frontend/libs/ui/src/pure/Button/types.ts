import { css } from 'styled-components/macro'

export enum ButtonSize {
  SMALL,
  DEFAULT,
  BIG,
}

// Ophis/Nucleus button size scale — aligns with the Nucleus typography scale
// (xl=24, md=16, xs=12) and Nucleus button heights (lg ~56, sm ~32).
export const BUTTON_SIZES_STYLE = {
  [ButtonSize.BIG]: css`
    font-size: 24px;
    font-weight: 700;
    min-height: 64px;
    padding: 0 32px;
  `,
  [ButtonSize.DEFAULT]: css`
    font-size: 16px;
    font-weight: 700;
  `,
  [ButtonSize.SMALL]: css`
    font-size: 12px;
    font-weight: 700;
    min-height: 32px;
    padding: 0 16px;
  `,
}
