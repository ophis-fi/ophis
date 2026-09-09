import styled, { css } from 'styled-components/macro'

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
  font-size: 11px;
  padding: 2px 7px;
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
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 20px;
`

export const TabButton = styled.button<{ $active: boolean }>`
  appearance: none;
  border: 1px solid var(--cow-color-border);
  border-radius: 12px;
  background: ${({ $active }) => ($active ? 'var(--cow-color-paper-darker)' : 'transparent')};
  color: ${({ $active }) => ($active ? 'var(--cow-color-primary)' : 'var(--cow-color-text)')};
  text-decoration: ${({ $active }) => ($active ? 'underline' : 'none')};
  text-underline-offset: 4px;
  font: inherit;
  font-size: 14px;
  padding: 8px 16px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--cow-color-primary);
    outline-offset: 2px;
  }

  ${({ $active }) =>
    $active &&
    css`
      border-color: var(--cow-color-primary);
    `}
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
  min-width: 160px;

  label {
    font-size: 12px;
    color: var(--cow-color-text);
  }

  input,
  select {
    appearance: none;
    background: var(--cow-color-paper-darker);
    border: 1px solid var(--cow-color-border);
    border-radius: 8px;
    color: var(--cow-color-text);
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;

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
  margin: 0 0 16px;
`

export const StatusStack = styled.div`
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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
