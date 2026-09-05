import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

// Base brand blue (#0052ff) as the resting tint; the attention state reuses the same
// amber wash as the Robinhood panel so "read this before trading" looks the same on
// every chain.
export const Panel = styled.aside<{ $attention: boolean }>`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  margin: 2px 0;
  padding: 11px 12px;
  border: 1px solid ${({ $attention }) => ($attention ? 'rgba(255, 178, 55, 0.42)' : 'rgba(0, 82, 255, 0.28)')};
  border-radius: var(--ophis-radius-md, 16px);
  background: ${({ $attention }) =>
    $attention
      ? 'linear-gradient(120deg, rgba(255, 178, 55, 0.10), rgba(255, 178, 55, 0.025))'
      : 'linear-gradient(120deg, rgba(0, 82, 255, 0.085), rgba(0, 82, 255, 0.018))'};
  color: var(${UI.COLOR_TEXT_PAPER});
`

export const Mark = styled.div`
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: #0052ff;
  color: #ffffff;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.02em;
  box-shadow: 0 6px 18px rgba(0, 82, 255, 0.22);
`

export const Content = styled.div`
  min-width: 0;

  strong {
    display: block;
    font-size: 13px;
    line-height: 1.3;
  }

  p {
    margin: 3px 0 0;
    color: var(${UI.COLOR_TEXT_OPACITY_70});
    font-size: 11px;
    line-height: 1.45;
  }

  a {
    color: inherit;
    font-weight: 650;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
`

export const AssetDetail = styled.span`
  display: block;
`
