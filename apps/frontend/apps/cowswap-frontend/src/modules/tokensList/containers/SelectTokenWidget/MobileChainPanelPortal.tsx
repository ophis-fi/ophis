import { MouseEvent, ReactNode, useContext } from 'react'

import { ChainInfo } from '@cowprotocol/cow-sdk'

import { createPortal } from 'react-dom'

import { Field } from 'legacy/state/types'

import { TradeType } from 'modules/trade'

import { InlineChainPanel } from './InlineChainPanel.container'
import { InlineTokenPickerContext } from './inlineTokenPicker.context'
import { MobileChainPanelCard, MobileChainPanelOverlay } from './styled'

import { ChainPanel } from '../../pure/ChainPanel'
import { ChainsToSelectState } from '../../types'

interface MobileChainPanelPortalProps {
  chainsPanelTitle: string
  chainsToSelect: ChainsToSelectState | undefined
  onSelectChain: (chain: ChainInfo) => void
  onClose(): void
  tradeType?: TradeType
  field?: Field
  counterChainId?: ChainInfo['id']
}

export function MobileChainPanelPortal({
  chainsPanelTitle,
  chainsToSelect,
  onSelectChain,
  onClose,
  tradeType,
  field,
  counterChainId,
}: MobileChainPanelPortalProps): ReactNode {
  const inline = useContext(InlineTokenPickerContext)
  if (typeof document === 'undefined') {
    return null
  }

  const panel = (
    <ChainPanel
      title={chainsPanelTitle}
      chainsState={chainsToSelect}
      onSelectChain={(chain) => {
        onSelectChain(chain)
        onClose()
      }}
      variant={inline ? 'inline' : 'fullscreen'}
      onClose={onClose}
      tradeType={tradeType}
      field={field}
      counterChainId={counterChainId}
    />
  )

  // The expanded swap slab owns this subview as well as the token list.
  // Only the regular mobile modal belongs in a document-level portal.
  if (inline) {
    return (
      <InlineChainPanel title={chainsPanelTitle} onClose={onClose}>
        {panel}
      </InlineChainPanel>
    )
  }

  return createPortal(
    <MobileChainPanelOverlay onClick={onClose}>
      <MobileChainPanelCard onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}>
        {panel}
      </MobileChainPanelCard>
    </MobileChainPanelOverlay>,
    document.body,
  )
}
