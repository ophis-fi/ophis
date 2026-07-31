import styled from 'styled-components/macro'

/**
 * Same glass treatment as the Trending panel so the side rail reads as one
 * surface. Keep the two in step if either is restyled.
 */
export const Panel = styled.aside`
  width: 300px;
  flex: none;
  align-self: flex-start;
  padding: 14px 14px 10px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.028);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(16px);
  box-shadow:
    0 24px 70px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  color: ${({ theme }) => theme.text1};
`

export const Head = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
`

export const Symbol = styled.h2`
  margin: 0;
  font-weight: 600;
  font-size: 13.5px;
  letter-spacing: 0.2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const Price = styled.span`
  font-size: 12px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`

export const Ranges = styled.div`
  margin-left: auto;
  display: flex;
  gap: 2px;
`

export const RangeButton = styled.button<{ active: boolean }>`
  background: ${({ active }) => (active ? 'rgba(255, 255, 255, 0.08)' : 'transparent')};
  border: none;
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 10.5px;
  font-weight: ${({ active }) => (active ? 600 : 400)};
  cursor: pointer;
  color: ${({ theme }) => theme.text1};
  opacity: ${({ active }) => (active ? 1 : 0.5)};

  &:hover {
    opacity: 1;
  }

  /* Visible focus ring: these are the only interactive controls in the rail. */
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.text1};
    outline-offset: 1px;
  }
`

/**
 * lightweight-charts writes into this node and sizes itself to the container, so
 * the height must be explicit rather than derived from content.
 */
export const ChartHost = styled.div`
  width: 100%;
  height: 120px;
`

export const Placeholder = styled.div`
  width: 100%;
  height: 120px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
`
