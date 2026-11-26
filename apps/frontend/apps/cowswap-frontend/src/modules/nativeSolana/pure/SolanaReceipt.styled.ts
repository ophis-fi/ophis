import styled from 'styled-components/macro'

import * as styledEl from './NativeSolana.styled'
import * as formStyles from './SwapForm.styled'

export const Receipt = styled(styledEl.Card)`
  width: min(100%, 470px);
  box-sizing: border-box;
  margin-inline: auto;
  gap: 14px;
  padding: clamp(14px, 3vw, 24px);
  h2 {
    margin: 0;
    font-size: 20px;
  }
  small {
    color: var(--cow-color-text2);
  }
  details {
    padding: 12px 0 0;
    border-top: 1px solid var(--cow-color-border);
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  details[open] > summary svg {
    transform: rotate(180deg);
  }
  details[open] > * + * {
    margin-top: 14px;
  }
`
export const Network = styled.small`
  display: flex;
  align-items: center;
  gap: 6px;
  img {
    width: 16px;
    height: 16px;
  }
`
export const Slabs = styled.div`
  position: relative;
  display: grid;
  grid-template-rows: 1fr 1fr;
  gap: 4px;
`
export const Flow = styled.span`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 2px solid var(--cow-color-paper);
  border-radius: 50%;
  background: var(--cow-color-paper-darkest);
`
export const CoinStack = styled.span`
  position: relative;
  display: inline-flex;
  &::after {
    content: '';
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 12px;
    height: 12px;
    border: 1px solid var(--cow-color-paper);
    border-radius: 50%;
    background: #17191c url('/logos/token-sol.svg') center / 10px no-repeat;
  }
`
export const Slab = styled.section`
  padding: 16px 18px;
  border-radius: 18px;
  background: var(--cow-color-paper-darker);
  overflow-wrap: anywhere;
  ${formStyles.AmountText} {
    display: block;
    margin-top: 10px;
    line-height: 1.15;
  }
`
export const Token = styled.span`
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 5px 10px;
  border-radius: 24px;
  background: var(--cow-color-paper);
  font-weight: 600;
`
export const Status = styled.span<{ $filled: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: ${({ $filled }) => ($filled ? 'var(--cow-color-success)' : 'var(--cow-color-text)')};
  background: ${({ $filled }) => ($filled ? 'var(--cow-color-success-bg)' : 'var(--cow-color-paper-darker)')};
`
export const ExplorerAction = styled.a`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 28px;
  text-align: center;
  padding: 14px;
  font-weight: 600;
  text-decoration: none;
  background: var(--cow-color-text);
  color: var(--cow-color-paper);
`
export const Activity = styled.button`
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--cow-color-border);
  border-radius: 12px;
  background: var(--cow-color-paper);
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
  &:hover {
    background: var(--cow-color-paper-darker);
  }
  small {
    display: block;
    color: var(--cow-color-text2);
  }
`
