import styled from 'styled-components/macro'

export const WriteGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`

export const WriteField = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--cow-color-text);
  font-size: 13px;

  input,
  select {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--cow-color-border);
    border-radius: 10px;
    background: var(--cow-color-paper);
    color: var(--cow-color-text);
    font: inherit;
    font-size: 16px;
    padding: 11px 12px;
    min-height: 44px;
    font-variant-numeric: tabular-nums;

    &:focus-visible {
      outline: 2px solid var(--cow-color-primary);
      outline-offset: 2px;
    }
  }
`

export const WriteHint = styled.span`
  min-height: 18px;
  color: var(--cow-color-text);
  font-size: 12px;
`

export const WriteSummary = styled.div`
  margin: 0;
  padding: 14px;
  border: 1px solid var(--cow-color-border);
  border-radius: 12px;
  background: var(--cow-color-paper-darker);
  font-size: 14px;
  font-variant-numeric: tabular-nums;

  p {
    margin: 4px 0;
  }
`

export const ReviewLabel = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0;
  color: var(--cow-color-text);
  font-size: 14px;

  input {
    margin-top: 3px;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    accent-color: var(--cow-color-primary);
  }
`

export const PrimaryAction = styled.button`
  appearance: none;
  width: 100%;
  border: 1px solid var(--cow-color-primary);
  border-radius: 10px;
  background: var(--cow-color-primary);
  color: var(--cow-color-button-text);
  font: inherit;
  font-weight: 600;
  padding: 12px 18px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--cow-color-primary-darker);
  }

  &:focus-visible {
    outline: 2px solid var(--cow-color-primary);
    outline-offset: 2px;
  }

  &:disabled {
    border-color: var(--cow-color-border);
    background: var(--cow-color-paper-darker);
    color: var(--cow-color-text);
    cursor: not-allowed;
  }
`

export const InlineStatus = styled.p`
  margin: 10px 0 0;
  color: var(--cow-color-text);
  font-size: 13px;
  overflow-wrap: anywhere;
`

export const TokenSelect = styled.div`
  position: relative;
  display: flex;
  align-items: center;

  > div {
    position: absolute;
    left: 12px;
    pointer-events: none;
  }

  select {
    padding-left: 46px;
  }
`
