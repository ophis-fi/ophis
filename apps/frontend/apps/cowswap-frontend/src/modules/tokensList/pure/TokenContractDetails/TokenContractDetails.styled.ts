import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

export const ContractDetails = styled.div<{ $verified: boolean }>`
  width: 240px;
  padding: 8px 12px 10px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 4px 8px;
  color: ${({ $verified }) => ($verified ? `var(${UI.COLOR_SUCCESS})` : `var(${UI.COLOR_TEXT_OPACITY_70})`)};

  > svg {
    margin-top: 1px;
  }
`

export const ContractStatus = styled.span`
  font-size: 13px;
  font-weight: 600;
`

export const ContractAddress = styled.span`
  grid-column: 1 / -1;
  color: var(${UI.COLOR_TEXT_OPACITY_70});
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  overflow-wrap: anywhere;
`
