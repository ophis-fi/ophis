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
  color: #f5efe6;
  font-size: 13px;

  input,
  select {
    width: 100%;
    box-sizing: border-box;
    appearance: none;
    border: 1px solid rgba(245, 239, 230, 0.2);
    border-radius: 10px;
    background: rgba(245, 239, 230, 0.06);
    color: #f5efe6;
    font: inherit;
    font-size: 16px;
    padding: 11px 12px;

    &:focus-visible {
      outline: 2px solid rgba(242, 166, 62, 0.7);
      outline-offset: 2px;
    }
  }
`

export const WriteHint = styled.span`
  min-height: 18px;
  color: rgba(245, 239, 230, 0.68);
  font-size: 12px;
`

export const WriteSummary = styled.div`
  margin: 16px 0;
  padding: 14px;
  border: 1px solid rgba(245, 239, 230, 0.18);
  border-radius: 12px;
  background: rgba(245, 239, 230, 0.04);

  p {
    margin: 4px 0;
  }
`

export const ReviewLabel = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 14px 0;
  color: #f5efe6;
  font-size: 14px;

  input {
    margin-top: 3px;
  }
`

export const PrimaryAction = styled.button`
  appearance: none;
  width: 100%;
  border: 1px solid rgba(242, 166, 62, 0.72);
  border-radius: 10px;
  background: #f2a63e;
  color: #19140e;
  font: inherit;
  font-weight: 700;
  padding: 12px 18px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: #f5b45b;
  }

  &:focus-visible {
    outline: 2px solid #f5efe6;
    outline-offset: 2px;
  }

  &:disabled {
    border-color: rgba(245, 239, 230, 0.15);
    background: rgba(245, 239, 230, 0.08);
    color: rgba(245, 239, 230, 0.48);
    cursor: not-allowed;
  }
`

export const InlineStatus = styled.p`
  margin: 10px 0 0;
  color: rgba(245, 239, 230, 0.76);
  font-size: 13px;
  overflow-wrap: anywhere;
`
