import styled from 'styled-components/macro'

export const Card = styled.section`
  width: 100%;
  margin: 16px 0 0;
  padding: 0;
  display: grid;
  gap: 18px;
  box-sizing: border-box;
  label {
    display: grid;
    gap: 8px;
  }
  input,
  select,
  button {
    font: inherit;
    border-radius: 10px;
    padding: 12px;
    min-height: 44px;
  }
  input,
  select {
    width: 100%;
    box-sizing: border-box;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
  }
  option {
    color: #17243c;
    background: #fff;
  }
  button {
    cursor: pointer;
    background: #1b3158;
    color: #fff;
    border: 0;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 3px solid #ec985f;
    outline-offset: 3px;
  }
  p {
    margin: 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
  }
  dd {
    margin: 0;
    text-align: right;
  }
  a {
    color: inherit;
    text-decoration: underline;
    overflow-wrap: anywhere;
  }
`
