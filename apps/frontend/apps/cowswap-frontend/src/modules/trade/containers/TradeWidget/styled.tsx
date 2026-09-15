import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'
import { WIDGET_MAX_WIDTH } from 'theme'

type ContainerSizeProps = { isTokenSelectOpen?: boolean; isTokenSelectWide?: boolean }

const getContainerMaxWidth = ({ isTokenSelectOpen, isTokenSelectWide }: ContainerSizeProps): string => {
  if (!isTokenSelectOpen) {
    return WIDGET_MAX_WIDTH.swap
  }

  return isTokenSelectWide ? WIDGET_MAX_WIDTH.tokenSelectSidebar : WIDGET_MAX_WIDTH.tokenSelect
}

export const Container = styled.div<ContainerSizeProps>`
  width: 100%;
  max-width: ${getContainerMaxWidth};
  margin: 0 auto;
  position: relative;
`

export const ContainerBox = styled.div`
  display: flex;
  flex-flow: column wrap;
  gap: 10px;
  max-width: 100%;
  background: var(${UI.COLOR_PAPER});
  color: var(${UI.COLOR_TEXT_PAPER});
  border: 1px solid var(${UI.COLOR_BORDER});
  border-radius: 20px;
  box-shadow: ${({ theme }) => (theme.isWidget ? theme.boxShadow1 : 'none')};
  padding: var(--ophis-space-3, 12px);
  position: relative;
  ${({ theme }) =>
    theme.isOphisMobileSwap && `border: 1px solid #e8e8ea; box-shadow: 0 1px 2px rgba(23,25,28,.04); padding: 16px;`}

  > div,
  > span {
    max-width: 100%;
  }

  .modalMode & {
    box-shadow: none;
  }
`

export const Header = styled.div`
  display: flex;
  gap: 8px;
  justify-content: space-between;
  align-items: center;
  padding: ${({ theme }) => (theme.isWidget ? '0 7px' : '0 5px 0 0')};
  margin: 0;
  color: inherit;
`

export const OuterContentWrapper = styled.div`
  margin-top: 10px;
`

export const HeaderRight = styled.div`
  display: flex;
  flex-direction: row;
  gap: 5px;
  align-items: center;
  font-size: 0;
`

export const CurrencySeparatorBox = styled.div<{ compactView: boolean }>`
  display: flex;
  justify-content: space-between;
  margin: ${({ compactView }) => (compactView ? '-5px 0' : '0')};
  padding: 0;
`
