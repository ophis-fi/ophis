import styled from 'styled-components/macro'

export const Stack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
`
export const Card = styled.section`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  border: 1px solid var(--cow-color-border);
  border-radius: 20px;
  background: var(--cow-color-paper);
  min-width: 0;
  h2,
  p {
    margin: 0;
  }
  code {
    overflow-wrap: anywhere;
    white-space: normal;
    font-size: 12px;
  }
`
export const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  input,
  select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 48px;
    padding: 12px;
    border: 1px solid var(--cow-color-border);
    border-radius: 10px;
    background: var(--cow-color-paper);
    color: inherit;
    font: inherit;
    font-size: 16px;
    &:focus-visible {
      outline: 2px solid var(--cow-color-primary);
      outline-offset: 2px;
    }
  }
`
export const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  overflow-wrap: anywhere;
`
export const Values = styled.dl`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  margin: 0;
  dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
  }
`

export const QuoteValues = styled(Values)`
  grid-template-columns: minmax(0, 1fr) fit-content(60%);
`
export const QuoteSymbol = styled.span`
  display: inline-block;
  max-width: 100%;
`
