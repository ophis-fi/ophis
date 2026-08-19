import { Opacity, UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

export const Wrapper = styled.div<{ $alwaysShow: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;

  &:hover {
    > button {
      opacity: ${Opacity.medium};
    }
  }

  > button {
    opacity: ${({ $alwaysShow }) => ($alwaysShow ? Opacity.medium : Opacity.none)};

    &:hover {
      opacity: ${Opacity.full};
    }
  }
`

export const AddressWrapper = styled.span`
  margin: 0;
  line-height: 1;
  font-size: 13px;
  font-weight: 400;
  color: var(${UI.COLOR_TEXT_OPACITY_50});
  opacity: ${Opacity.full};
`
