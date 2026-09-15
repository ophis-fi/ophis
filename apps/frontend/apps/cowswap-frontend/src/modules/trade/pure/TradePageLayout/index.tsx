import { Media, UI, MY_ORDERS_ID } from '@cowprotocol/ui'

import styled from 'styled-components/macro'
import { WIDGET_MAX_WIDTH } from 'theme'

const DEFAULT_MAX_WIDTH = '1200px'

export const PageWrapper = styled.div<{
  isUnlocked: boolean
  secondaryOnLeft?: boolean
  maxWidth?: string
  hideOrdersTable?: boolean
}>`
  width: 100%;
  display: grid;
  max-width: ${({ maxWidth = DEFAULT_MAX_WIDTH }) => maxWidth};
  margin: 0 auto;
  align-items: start;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto;
  grid-template-areas: ${({ hideOrdersTable }) => (hideOrdersTable ? '"primary"' : '"primary" "secondary"')};
  gap: 32px;

  ${Media.LargeAndUp()} {
    grid-template-columns: ${({ isUnlocked, hideOrdersTable, secondaryOnLeft }) =>
      isUnlocked && !hideOrdersTable
        ? secondaryOnLeft
          ? 'minmax(0, 1fr) minmax(0, ' + WIDGET_MAX_WIDTH.swap + ')'
          : 'minmax(0, ' + WIDGET_MAX_WIDTH.swap + ') minmax(0, 1fr)'
        : '1fr'};
    grid-template-rows: 1fr;
    grid-template-areas: ${({ secondaryOnLeft, hideOrdersTable }) =>
      hideOrdersTable ? '"primary"' : secondaryOnLeft ? '"secondary primary"' : '"primary secondary"'};
  }

  > .trade-orders-table {
    display: ${({ isUnlocked }) => (!isUnlocked ? 'none' : '')};
  }
`

// Form + banner
export const PrimaryWrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  min-width: 0;
  max-width: ${WIDGET_MAX_WIDTH.swap};
  margin: 0 auto;
  color: inherit;
  grid-area: primary;
`

// Graph + orders table
export const SecondaryWrapper = styled.div.attrs({
  id: MY_ORDERS_ID,
})`
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow: hidden;
  border-radius: 20px;
  background: var(${UI.COLOR_PAPER});
  color: inherit;
  border: 1px solid var(${UI.COLOR_BORDER});
  box-shadow: none;
  position: relative;
  padding: 12px;
  min-width: 0;
  min-height: 400px;
  margin: 0;
  grid-area: secondary;

  ${Media.upToLargeAlt()} {
    flex-direction: column;
    min-height: 0;
    padding: 12px;
  }
`
