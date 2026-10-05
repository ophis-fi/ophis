import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

export const Quote = styled.section`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
  width: 100%;
  color: var(${UI.COLOR_TEXT});
  overflow-wrap: anywhere;
  p {
    margin: 0;
  }
  small {
    font-size: 12px;
    line-height: 1.5;
    color: var(${UI.COLOR_TEXT_OPACITY_70});
  }
`

export const Amount = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  padding: 18px;
  border-radius: 20px;
  background: var(${UI.COLOR_PAPER_DARKER});
  > span {
    font-size: 13px;
    color: var(${UI.COLOR_TEXT_OPACITY_70});
  }
  > div {
    justify-content: flex-start;
    text-align: left;
    line-height: 1.4;
    font-size: 20px;
  }
`

export const Details = styled.dl`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  margin: 0;
  padding: 4px 0;
  font-size: 13px;
  line-height: 1.5;
  dt {
    color: var(${UI.COLOR_TEXT_OPACITY_70});
  }
  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
`

export const Address = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(${UI.COLOR_BORDER});
  border-radius: 16px;
  font-size: 12px;
  > span {
    color: var(${UI.COLOR_TEXT_OPACITY_70});
    align-self: center;
  }
  code {
    grid-column: 1 / -1;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 1.5;
    user-select: all;
  }
  button {
    display: grid;
    place-items: center;
    background: transparent;
    color: inherit;
    border: 0;
    padding: 6px;
    cursor: pointer;
    border-radius: 6px;
    &:focus-visible {
      outline: 2px solid var(${UI.COLOR_PRIMARY});
    }
  }
`
