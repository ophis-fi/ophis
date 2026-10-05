import { ReactNode, useContext } from 'react'

import { useMediaQuery } from '@cowprotocol/common-hooks'
import { Media } from '@cowprotocol/ui'

import { DesktopChainPanel } from './DesktopChainPanel'

import { useSelectTokenWidgetState } from '../../../../hooks/useSelectTokenWidgetState'
import { useChainAnalyticsContext, useChainPanelState } from '../../hooks'
import { InlineTokenPickerContext } from '../../inlineTokenPicker.context'

export function ConnectedDesktopChainPanel(): ReactNode {
  const inline = useContext(InlineTokenPickerContext)
  const widgetState = useSelectTokenWidgetState()
  const chainPanel = useChainPanelState(widgetState.tradeType, widgetState.field)
  const analyticsContext = useChainAnalyticsContext()
  const isCompactLayout = useMediaQuery(Media.upToMedium(false))

  if (!chainPanel.isEnabled || isCompactLayout || inline) return null

  return (
    <DesktopChainPanel
      chains={chainPanel.chainsToSelect}
      onSelectChain={chainPanel.onSelectChain}
      tradeType={analyticsContext.tradeType}
      field={analyticsContext.field}
      counterChainId={analyticsContext.counterChainId}
    />
  )
}
