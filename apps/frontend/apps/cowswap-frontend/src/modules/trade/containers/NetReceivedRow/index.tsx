import { ReactNode, useCallback } from 'react'

import { useVolumeFeeTooltip } from 'modules/volumeFee'

import { trackGa4Event } from 'ophis/analytics/track'

import { useNetReceivedUsd } from '../../hooks/useNetReceivedUsd'
import { NetReceivedRowContent } from '../../pure/NetReceivedRow'
import { ReceiveAmountInfo } from '../../types'

interface NetReceivedRowProps {
  receiveAmountInfo: ReceiveAmountInfo | null
  /** Widget param: suppress USD values (the row degrades to the token amount). */
  hideUsdValues?: boolean
}

/**
 * Net-of-costs headline container (ux-quoting decision 59). Renders nothing
 * when there is no quote or the quoted costs consume the whole output; the
 * placement decision is judged by the `net_received_tooltip_open` GA4 event.
 */
export function NetReceivedRow({ receiveAmountInfo, hideUsdValues }: NetReceivedRowProps): ReactNode {
  const netInfo = useNetReceivedUsd(receiveAmountInfo)
  const volumeFeeTooltip = useVolumeFeeTooltip()

  const onTooltipOpen = useCallback(() => {
    trackGa4Event('net_received_tooltip_open', { kind: netInfo.kind })
  }, [netInfo.kind])

  if (!netInfo.netAmount || !receiveAmountInfo) return null

  const feeBps = receiveAmountInfo.costs.partnerFee.bps + (receiveAmountInfo.costs.protocolFee?.bps ?? 0)

  return (
    <NetReceivedRowContent
      netAmount={netInfo.netAmount}
      netUsd={netInfo.netUsd}
      grossUsd={netInfo.grossUsd}
      totalCostsUsd={netInfo.totalCostsUsd}
      userPaysGasOnTop={netInfo.userPaysGasOnTop}
      kind={netInfo.kind}
      feeLabel={volumeFeeTooltip.label}
      feeBps={feeBps}
      hideUsdValues={hideUsdValues}
      onTooltipOpen={onTooltipOpen}
    />
  )
}
