import styled from 'styled-components/macro'

export const Card = styled.section`
  display: grid;
  gap: 12px;
  margin: 16px 0;
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  input,
  button {
    font: inherit;
    padding: 12px;
    min-height: 44px;
    border-radius: 12px;
  }
  button {
    border: 0;
    background: #171a1b;
    color: #fff;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  input {
    width: 100%;
    box-sizing: border-box;
  }
  input:focus-visible,
  button:focus-visible {
    outline: 3px solid #ec985f;
    outline-offset: 3px;
  }
  a {
    color: inherit;
    text-decoration: underline;
  }
`
