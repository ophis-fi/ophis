import { MouseEvent, ReactNode } from 'react'

import { useMediaQuery } from '@cowprotocol/common-hooks'
import { Media } from '@cowprotocol/ui'

import { createPortal } from 'react-dom'

import {
  ConnectedChainSelector,
  ConnectedDesktopChainPanel,
  ConnectedHeader,
  ConnectedSearch,
  ConnectedTokenList,
  ImportListView,
  ImportTokenView,
  LpTokenView,
  ManageView,
  NetworkPanel,
} from './slots'

import { useCloseTokenSelectWidget } from '../../../hooks/useCloseTokenSelectWidget'
import { useSelectTokenWidgetState } from '../../../hooks/useSelectTokenWidgetState'
import { useChainPanelState, useDismissHandler, useManageWidgetVisibility, useWidgetOpenState } from '../hooks'
import { InnerWrapper, ModalContainer, WidgetCard, WidgetOverlay, Wrapper } from '../styled'

export interface SelectTokenModalProps {
  children: ReactNode
}

export function SelectTokenModal({ children }: SelectTokenModalProps): ReactNode {
  const widgetState = useSelectTokenWidgetState()
  const chainPanel = useChainPanelState(widgetState.tradeType, widgetState.field)

  return <SelectTokenModalFrame hasChainPanel={chainPanel.isEnabled}>{children}</SelectTokenModalFrame>
}

export function SelectTokenModalFrame({
  children,
  hasChainPanel = false,
}: SelectTokenModalProps & { hasChainPanel?: boolean }): ReactNode {
  const isOpen = useWidgetOpenState()
  const isCompactLayout = useMediaQuery(Media.upToMedium(false))
  const { closeManageWidget } = useManageWidgetVisibility()
  const closeTokenSelectWidget = useCloseTokenSelectWidget()
  const onDismiss = useDismissHandler(closeManageWidget, closeTokenSelectWidget)

  const isChainPanelVisible = hasChainPanel && !isCompactLayout

  if (!isOpen) return null

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onDismiss()
  }

  const content = (
    <Wrapper>
      <InnerWrapper $hasSidebar={isChainPanelVisible} $isMobileOverlay={isCompactLayout}>
        <ModalContainer>{children}</ModalContainer>
      </InnerWrapper>
    </Wrapper>
  )

  const overlay = (
    <WidgetOverlay onClick={handleOverlayClick}>
      <WidgetCard $isCompactLayout={isCompactLayout} $hasChainPanel={hasChainPanel}>
        {content}
      </WidgetCard>
    </WidgetOverlay>
  )

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}

// Slot components
SelectTokenModal.Header = ConnectedHeader
SelectTokenModal.Search = ConnectedSearch
SelectTokenModal.TokenList = ConnectedTokenList
SelectTokenModal.Panel = NetworkPanel
SelectTokenModal.ChainSelector = ConnectedChainSelector
SelectTokenModal.DesktopChainPanel = ConnectedDesktopChainPanel

// Blocking views
SelectTokenModal.ImportToken = ImportTokenView
SelectTokenModal.ImportList = ImportListView
SelectTokenModal.Manage = ManageView
SelectTokenModal.LpToken = LpTokenView
