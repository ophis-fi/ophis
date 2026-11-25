import styled from 'styled-components/macro'

export const Swap = styled.form`
  display: grid;
  gap: 10px;
  padding: clamp(14px, 3vw, 24px);
  border-radius: 24px;
  border: 1px solid var(--cow-color-border);
  background: var(--cow-color-paper);
  box-shadow: 0 10px 36px rgb(30 26 46 / 5%);
  min-width: 0;
`
export const Line = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  h2,
  p {
    margin: 0;
  }
`
export const Panel = styled.section`
  display: grid;
  align-content: center;
  gap: 12px;
  height: 100%;
  box-sizing: border-box;
  padding: 18px;
  min-width: 0;
`
export const Caption = styled.p`
  font-size: 13px;
  font-weight: 600;
  margin: 8px 0;
`
export const Coin = styled.img`
  width: 28px;
  height: 28px;
  object-fit: contain;
  border-radius: 50%;
  flex: none;
`
export const CoinLetter = styled.span`
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #453779;
  color: white;
  font-weight: 650;
  flex: none;
`
export const SmallButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: fit-content;
  padding: 6px 10px;
  border: 1px solid var(--cow-color-border);
  border-radius: 12px;
  background: var(--cow-color-paper);
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  &:hover:not(:disabled) {
    border-color: currentColor;
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
`
export const TokenButton = styled(SmallButton)`
  font-size: 16px;
  font-weight: 650;
  min-height: 42px;
  border-radius: 24px;
  gap: 8px;
`
export const Amount = styled.input`
  width: 100%;
  min-width: 65px;
  flex: 1 1 90px;
  padding: 0;
  background: transparent;
  color: inherit;
  border: 0;
  font: inherit;
  font-size: clamp(26px, 5vw, 38px);
  font-variant-numeric: tabular-nums;
  &:focus-visible {
    outline: 2px solid var(--cow-color-primary);
    outline-offset: 2px;
  }
`
export const AmountText = styled.span`
  font-size: clamp(26px, 5vw, 38px);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  min-width: 0;
`
export const Helper = styled.div`
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
`
export const Dialog = styled.dialog`
  width: min(420px, calc(100% - 32px));
  box-sizing: border-box;
  max-height: min(70vh, 620px);
  padding: 20px;
  color: inherit;
  background: var(--cow-color-paper);
  border: 1px solid var(--cow-color-border);
  border-radius: 20px;
  box-shadow: 0 18px 70px #0003;
  &::backdrop {
    background: #15132173;
  }
  h2 {
    font-size: 20px;
  }
  section {
    margin-top: 12px;
  }
`
export const Search = styled.input`
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 16px;
  margin-top: 14px;
  border: 1px solid var(--cow-color-border);
  padding: 12px;
  background: var(--cow-color-paper);
  color: inherit;
  border-radius: 10px;
`
export const Option = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 56px;
  padding: 8px;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
  font: inherit;
  background: transparent;
  color: inherit;
  text-align: left;
  &:disabled {
    cursor: default;
    opacity: 0.7;
  }
  &:hover:not(:disabled),
  &:focus-visible {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }
  span {
    min-width: 0;
  }
  strong,
  small {
    display: block;
  }
  small {
    margin-top: 3px;
    opacity: 0.8;
  }
  b {
    margin-left: auto;
    overflow-wrap: anywhere;
  }
`
export const Settings = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  select {
    font: inherit;
    color: inherit;
    border: 1px solid var(--cow-color-border);
    border-radius: 8px;
    background: var(--cow-color-paper);
    padding: 5px;
  }
`
