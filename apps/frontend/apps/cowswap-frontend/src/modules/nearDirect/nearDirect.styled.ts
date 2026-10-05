import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

export const Panel = styled.section`
  background: var(${UI.COLOR_PAPER});
  color: var(${UI.COLOR_TEXT});
  border: 1px solid var(${UI.COLOR_BORDER});
  border-radius: 24px;
  padding: 24px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  width: 100%;
  min-width: 0;
  label {
    display: grid;
    gap: 6px;
    font-size: 14px;
  }
  input,
  select,
  button {
    font: inherit;
    border-radius: 12px;
    padding: 12px;
    min-width: 0;
  }
  input,
  select {
    width: 100%;
    border: 1px solid #8887;
    color: inherit;
    background: transparent;
  }
  button {
    cursor: pointer;
    border: 1px solid #8887;
    color: inherit;
    background: transparent;
  }
  button[type='submit'] {
    background: #202020;
    color: white;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  fieldset {
    display: grid;
    gap: 16px;
    min-width: 0;
    border: 0;
    padding: 0;
    margin: 0;
  }
  h2,
  h3,
  p {
    margin: 0;
  }
  p,
  code {
    overflow-wrap: anywhere;
  }
  code {
    user-select: all;
    font-size: 13px;
  }
  small {
    opacity: 0.8;
  }
  [role='alert'] {
    color: #b02424;
  }
`

export const Stack = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  > * {
    min-width: 0;
    max-width: 100%;
  }
`

export const ReviewPanel = styled(Stack)`
  border: 1px solid var(${UI.COLOR_BORDER});
  background: var(${UI.COLOR_PAPER});
  color: var(${UI.COLOR_TEXT});
  border-radius: 24px;
  padding: 20px;
  h2 {
    font-size: 20px;
    scroll-margin-top: 96px;
    margin: 0 0 8px;
  }
`
