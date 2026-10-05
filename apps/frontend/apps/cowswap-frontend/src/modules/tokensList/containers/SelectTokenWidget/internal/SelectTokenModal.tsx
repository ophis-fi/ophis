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
import { useInlineTokenPickerBack } from '../hooks/useInlineTokenPickerBack'
import { InlineTokenPickerContext } from '../inlineTokenPicker.context'
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
  const { field } = useSelectTokenWidgetState()
  const isCompactLayout = useMediaQuery(Media.upToMedium(false))
  const { closeManageWidget } = useManageWidgetVisibility()
  const closeTokenSelectWidget = useCloseTokenSelectWidget()
  const onDismiss = useDismissHandler(closeManageWidget, closeTokenSelectWidget)
  const onInlineBack = useInlineTokenPickerBack(onDismiss)

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

  // In the market swap form, both slab targets already exist before
  // opening. Portal the same picker, including consent/import flows, into its
  // originating slab; all other widgets retain their existing modal.
  const slab = typeof document !== 'undefined' ? document.getElementById(`asset-swap-picker-${field}`) : null
  if (slab)
    return createPortal(
      <InlineTokenPickerContext.Provider value>
        <div
          className="swp-inline-token-list"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            // Handle the active view before document-level Back listeners and
            // the slab's outer Escape handler can both dismiss it.
            event.preventDefault()
            event.stopPropagation()
            onInlineBack()
          }}
        >
          {children}
        </div>
      </InlineTokenPickerContext.Provider>,
      slab,
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
