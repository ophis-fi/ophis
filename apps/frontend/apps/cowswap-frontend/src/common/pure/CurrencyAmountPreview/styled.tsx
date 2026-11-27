import { Media, UI } from '@cowprotocol/ui'

import { ArrowRight } from 'react-feather'
import styled from 'styled-components/macro'

export const Container = styled.div`
  padding: 24px 12px;
  width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  height: 100%;
  border-radius: 24px;
  background: var(${UI.COLOR_PAPER_DARKER});
  font-size: 14px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 20px;

  ${Media.upToSmall()} {
    font-size: 13px;
    letter-spacing: -0.1px;
  }
`

export const Amount = styled.div`
  font-size: 15px;
  font-weight: 600;
  display: flex;
  flex-flow: column wrap;
  gap: 6px;

  // Targets FiatValue
  > div {
    font-weight: 500;
    font-size: 13px;
  }
`

export const TokenLogoWrapper = styled.div`
  display: inline-block;
  border-radius: 50%;
  line-height: 0;
  box-shadow: ${({ theme }) =>
    theme.isOphisMobileSwap ? 'none' : `0 2px 10px 0 ${theme.darkMode ? '#496e9f' : '#bfd6f7'}`};
`

export const AmountsPreviewContainer = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: max-content;
  gap: 6px;
  width: 100%;
  align-items: stretch;
  justify-content: space-between;
  position: relative;
`

export const SeparatorWrapper = styled.div`
  --size: 36px;
  --padding: 4px;
  pointer-events: none;
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  margin: auto;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: calc(var(--size) + var(--padding) * 2);
`

export const AmountsSeparator = styled(ArrowRight)`
  width: var(--size);
  height: var(--size);
  border-radius: var(--size);
  background: var(${UI.COLOR_PAPER_DARKER});
  border: var(--padding) solid var(${UI.COLOR_PAPER});
  padding: var(--padding);
  position: relative;
  z-index: 1;
`
