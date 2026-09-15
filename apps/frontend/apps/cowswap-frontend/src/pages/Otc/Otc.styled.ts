import { Table } from 'ophis/ds'
import styled from 'styled-components/macro'

export const OtcStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;

  @media (max-width: 600px) {
    gap: 16px;
  }
`

export const Mono = styled.span`
  font-family: var(--cow-font-family-mono, ui-monospace, monospace);
  font-size: 0.92em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
`

/* Screen-reader-only text (full addresses behind truncated display). */
export const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
`

export const CopyButton = styled.button`
  appearance: none;
  border: 1px solid var(--cow-color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--cow-color-text);
  font: inherit;
  font-size: 12px;
  min-height: 28px;
  min-width: 44px;
  padding: 4px 8px;
  margin-left: 6px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--cow-color-primary);
    outline-offset: 1px;
  }
`

export const RawNote = styled.span`
  color: var(--cow-color-text);
  font-size: 0.85em;
  margin-left: 0.35em;
`

export const TabBar = styled.div`
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-self: flex-start;
  max-width: 100%;
  padding: 4px;
  border: 1px solid var(--cow-color-border);
  border-radius: 12px;
  background: var(--cow-color-paper-darker);
`

export const TabButton = styled.button<{ $active: boolean }>`
  appearance: none;
  border: 1px solid ${({ $active }) => ($active ? 'var(--cow-color-border)' : 'transparent')};
  border-radius: 8px;
  background: ${({ $active }) => ($active ? 'var(--cow-color-paper)' : 'transparent')};
  color: var(--cow-color-text);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  min-height: 44px;
  padding: 8px 12px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--cow-color-primary);
    outline-offset: 2px;
  }
`

export const FilterBar = styled.div`
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 16px;
`

export const FilterField = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: min(160px, 100%);
  flex: 1 1 160px;

  label {
    font-size: 12px;
    color: var(--cow-color-text);
  }

  input,
  select {
    background: var(--cow-color-paper);
    border: 1px solid var(--cow-color-border);
    border-radius: 8px;
    color: var(--cow-color-text);
    font: inherit;
    font-size: 16px;
    padding: 10px 12px;
    min-height: 44px;
    min-width: 0;

    &:focus-visible {
      outline: 2px solid var(--cow-color-primary);
      outline-offset: 1px;
    }
  }
`

export const BadgeRow = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
`

export const StatusStack = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 160px;
  max-width: 230px;
`

export const DisabledAction = styled.button`
  appearance: none;
  border: 1px solid var(--cow-color-border);
  border-radius: 10px;
  background: var(--cow-color-paper-darker);
  color: var(--cow-color-text);
  font: inherit;
  font-size: 14px;
  padding: 10px 18px;
  cursor: not-allowed;
`

export const OrdersTable = styled(Table)`
  min-width: 960px;
  th {
    font-size: 13px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
  }
  td {
    padding: 16px;
    vertical-align: middle;
  }
`

export const Amount = styled.span`
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
`
