import { ReactNode } from 'react'

import { getBlockExplorerUrl, getEtherscanLink, getExplorerLabel } from '@cowprotocol/common-utils'

import { useSettlementTxHash } from 'ophis/hooks/useSettlementTxHash'

import { OrderStatus } from 'legacy/state/orders/actions'
import { useOrder } from 'legacy/state/orders/hooks'

import { ExternalLinkCustom } from './styled'

type DisplayLinkProps = {
  id: string | undefined
  chainId: number
  leadToBridgeTab: boolean
}

export function DisplayLink({ id, chainId, leadToBridgeTab }: DisplayLinkProps): ReactNode {
  const { orderCreationHash, status } = useOrder({ id, chainId }) || {}
  // Ophis fork: when fulfilled on a chain without a CoW-style explorer, prefer
  // the settlement tx Etherscan URL over the address-page fallback that
  // `getEtherscanLink` -> `getExplorerOrderLink` would otherwise produce.
  const settlementTxHash = useSettlementTxHash(chainId, status === OrderStatus.FULFILLED ? id : undefined)

  if (!id || !chainId) {
    return null
  }

  const ethFlowHash =
    orderCreationHash && (status === OrderStatus.CREATING || status === OrderStatus.FAILED)
      ? orderCreationHash
      : undefined
  const linkTarget = ethFlowHash ?? settlementTxHash ?? id
  const href = ethFlowHash
    ? getBlockExplorerUrl(chainId, 'transaction', ethFlowHash)
    : (settlementTxHash
        ? getBlockExplorerUrl(chainId, 'transaction', settlementTxHash)
        : getEtherscanLink(chainId, 'transaction', id)) + (leadToBridgeTab ? '?tab=bridge' : '')
  const label = getExplorerLabel(chainId, 'transaction', linkTarget)

  return <ExternalLinkCustom href={href}>{label} ↗</ExternalLinkCustom>
}
