import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

export const Activity = styled.section`
  display: grid;
  gap: 10px;
  width: 100%;
  min-width: 0;
  color: var(${UI.COLOR_TEXT});
  > header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 4px;
  }
  h3 {
    font-size: 16px;
    margin: 0;
  }
  button {
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  button:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(${UI.COLOR_PRIMARY});
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  > p {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(${UI.COLOR_TEXT_OPACITY_70});
  }
  [role='alert'] {
    color: var(${UI.COLOR_DANGER});
  }
`

export const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  button {
    border: 1px solid var(${UI.COLOR_BORDER});
    background: var(${UI.COLOR_PAPER});
    border-radius: 12px;
    min-height: 40px;
    padding: 8px 12px;
    font-size: 12px;
  }
`

export const Row = styled.div`
  position: relative;
  min-width: 0;
  border: 1px solid var(${UI.COLOR_BORDER});
  border-radius: 20px;
  background: var(${UI.COLOR_PAPER});
  &[hidden] {
    display: none;
  }
  summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 16px 58px 16px 16px;
    cursor: pointer;
    list-style: none;
    border-radius: 20px;
    &::-webkit-details-marker {
      display: none;
    }
    > span {
      display: grid;
      min-width: 0;
      gap: 5px;
    }
    strong {
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    small {
      color: var(${UI.COLOR_TEXT_OPACITY_70});
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    time {
      font-variant-numeric: tabular-nums;
    }
  }
  details[open] > summary > svg {
    transform: rotate(180deg);
  }
  details > section {
    border: 0;
    border-top: 1px solid var(${UI.COLOR_BORDER});
    border-radius: 0 0 20px 20px;
    padding: 16px;
  }
  > button {
    position: absolute;
    top: 12px;
    right: 10px;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    &:hover {
      background: var(${UI.COLOR_PAPER_DARKER});
    }
  }
`
