import styled from 'styled-components/macro'

export const Container = styled.div`
  width: 100%;
  margin: 0 auto;
  position: relative;

  #input-currency-input {
    --swap-token-color: #ff0420;
  }

  #output-currency-input {
    --swap-token-color: #4eb190;
  }

  .open-currency-select-button {
    --button-bg-hover: var(--button-bg);
    --button-text: var(--cow-color-text-paper);
    --button-border: var(--swap-token-color);
    --cow-color-button-text: var(--cow-color-text-paper);
  }
`
