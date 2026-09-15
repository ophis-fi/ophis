import { ReactNode, useState, useCallback } from 'react'

import { useMediaQuery } from '@cowprotocol/common-hooks'
import { ChainInfo } from '@cowprotocol/cow-sdk'
import { Media } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'

import { Field } from 'legacy/state/types'

import { TradeType } from 'modules/trade'

import { MobileChainSelector } from '../../../../pure/SelectTokenModal/MobileChainSelector'
import { ChainsToSelectState } from '../../../../types'
import { MobileChainPanelPortal } from '../../MobileChainPanelPortal'

export interface ChainSelectorProps {
  chains?: ChainsToSelectState
  title?: string
  onSelectChain: (chain: ChainInfo) => void
  tradeType?: TradeType
  field?: Field
  counterChainId?: ChainInfo['id']
}

export function ChainSelector({
  chains,
  title,
  onSelectChain,
  tradeType,
  field,
  counterChainId,
}: ChainSelectorProps): ReactNode {
  const resolvedTitle = title ?? (field === Field.OUTPUT ? t`Receive on` : t`Select network`)
  const [isMobilePanelOpen, setMobilePanelOpen] = useState(false)
  const isCompactLayout = useMediaQuery(Media.upToMedium(false))

  const openPanel = useCallback(() => setMobilePanelOpen(true), [])
  const closePanel = useCallback(() => setMobilePanelOpen(false), [])

  const handleSelectChain = useCallback(
    (chain: ChainInfo) => {
      onSelectChain(chain)
      closePanel()
    },
    [onSelectChain, closePanel],
  )

  if (!isCompactLayout || !chains) {
    return null
  }

  return (
    <>
      <MobileChainSelector
        chainsState={chains}
        label={resolvedTitle}
        onSelectChain={handleSelectChain}
        onOpenPanel={openPanel}
        tradeType={tradeType}
        field={field}
        counterChainId={counterChainId}
      />

      {isMobilePanelOpen && (
        <MobileChainPanelPortal
          chainsPanelTitle={resolvedTitle}
          chainsToSelect={chains}
          onSelectChain={onSelectChain}
          onClose={closePanel}
          tradeType={tradeType}
          field={field}
          counterChainId={counterChainId}
        />
      )}
    </>
  )
}
