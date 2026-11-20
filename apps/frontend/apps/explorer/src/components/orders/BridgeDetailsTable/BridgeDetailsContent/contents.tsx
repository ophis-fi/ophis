import React, { ReactNode } from 'react'

import { isAcrossV5Status, isRelayStatus } from '@cowprotocol/common-const'
import { displayTime } from '@cowprotocol/common-utils'
import { BridgeStatus, CrossChainOrder } from '@cowprotocol/sdk-bridging'

import { DetailRow } from '../../../common/DetailRow'
import { BridgeDetailsTooltips } from '../bridgeDetailsTooltips'
import { RefundStatus, RefundStatusEnum } from '../RefundStatus'

export function RefundStatusItem({ crossChainOrder }: { crossChainOrder: CrossChainOrder }): ReactNode {
  const { statusResult, explorerUrl } = crossChainOrder
  if (statusResult.status === BridgeStatus.REFUND && isAcrossV5Status(statusResult)) {
    return (
      <DetailRow label="Refund Status">
        <span>Across refund completed.</span>
      </DetailRow>
    )
  }
  if (statusResult.status === BridgeStatus.REFUND && isRelayStatus(statusResult)) {
    return (
      <DetailRow label="Refund Status" tooltipText="Refund details are available on Relay.">
        <span>Relay refund completed. View the Relay transaction for the refunded amount, token and network.</span>
        {explorerUrl && (
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
            View Relay transaction ↗
          </a>
        )}
      </DetailRow>
    )
  }
  if (statusResult.status !== BridgeStatus.EXPIRED || !(statusResult.depositTxHash || statusResult.fillTxHash))
    return null

  return (
    <DetailRow label="Refund Status" tooltipText="Status of the refund process for the failed bridge transaction">
      <RefundStatus
        status={RefundStatusEnum.NOT_INITIATED} // TODO: add refund statuses once we have them
      />
    </DetailRow>
  )
}

export function BridgingTime({
  bridgeStatus,
  fillTimeInSeconds,
}: {
  bridgeStatus: BridgeStatus
  fillTimeInSeconds: number | undefined
}): ReactNode {
  if (bridgeStatus !== BridgeStatus.IN_PROGRESS || !fillTimeInSeconds) {
    return null
  }

  return (
    <DetailRow label="Bridging Time" tooltipText={BridgeDetailsTooltips.bridgingTime}>
      {displayTime(fillTimeInSeconds * 1000, true)}
    </DetailRow>
  )
}
