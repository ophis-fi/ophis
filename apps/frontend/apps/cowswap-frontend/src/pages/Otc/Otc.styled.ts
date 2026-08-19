import styled, { css } from 'styled-components/macro'

export const Mono = styled.span`
  font-family: 'Geist Mono', var(--cow-font-family-mono, ui-monospace, monospace);
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
  border: 1px solid rgba(245, 239, 230, 0.18);
  border-radius: 6px;
  background: transparent;
  color: rgba(245, 239, 230, 0.75);
  font: inherit;
  font-size: 11px;
  padding: 2px 7px;
  margin-left: 6px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.55);
    outline-offset: 1px;
  }
`

export const RawNote = styled.span`
  color: rgba(245, 239, 230, 0.55);
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
  border: 1px solid rgba(245, 239, 230, 0.18);
  border-radius: 999px;
  background: ${({ $active }) => ($active ? 'rgba(242, 166, 62, 0.16)' : 'transparent')};
  color: ${({ $active }) => ($active ? '#f2a63e' : '#f5efe6')};
  text-decoration: ${({ $active }) => ($active ? 'underline' : 'none')};
  text-underline-offset: 4px;
  font: inherit;
  font-size: 14px;
  padding: 8px 16px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.55);
    outline-offset: 2px;
  }

  ${({ $active }) =>
    $active &&
    css`
      border-color: rgba(242, 166, 62, 0.55);
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
    color: rgba(245, 239, 230, 0.65);
  }

  input,
  select {
    appearance: none;
    background: rgba(245, 239, 230, 0.06);
    border: 1px solid rgba(245, 239, 230, 0.18);
    border-radius: 8px;
    color: #f5efe6;
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;

    &:focus-visible {
      outline: 2px solid rgba(242, 166, 62, 0.55);
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
  border: 1px solid rgba(245, 239, 230, 0.18);
  border-radius: 10px;
  background: rgba(245, 239, 230, 0.06);
  color: rgba(245, 239, 230, 0.45);
  font: inherit;
  font-size: 14px;
  padding: 10px 18px;
  cursor: not-allowed;
`
