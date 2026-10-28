import styled from 'styled-components/macro'

export const Wrapper = styled.div`
  width: 100%;
  max-width: 470px;
  margin: 0 auto;
  color: var(--ophis-steep-ink);
  font-size: 14px;
  button,
  input,
  select {
    font: inherit;
  }
  button {
    cursor: pointer;
  }
`

export const Mode = styled.nav`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 4px 16px;
  > div {
    display: flex;
    padding: 4px;
    background: var(--ophis-steep-mist);
    border-radius: 999px;
  }
  button {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 40px;
    padding: 8px 20px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--ophis-steep-muted);
  }
  button[aria-pressed='true'] {
    background: white;
    color: var(--ophis-steep-ink);
    box-shadow: 0 1px 3px #17191c14;
  }
  small {
    color: var(--ophis-steep-muted);
    font-size: 11px;
  }
`

export const Runtime = styled.iframe`
  display: block;
  width: 100%;
  border: 1px solid var(--ophis-steep-hair);
  border-radius: 20px;
  background: white;
`
