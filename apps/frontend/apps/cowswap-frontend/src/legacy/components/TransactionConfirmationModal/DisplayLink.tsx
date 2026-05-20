import { ReactNode } from 'react'

import { getBlockExplorerUrl, getEtherscanLink, getExplorerLabel } from '@cowprotocol/common-utils'

import { useSettlementTxHash } from 'ophis/hooks/useSettlementTxHash'

import { OrderStatus } from 'legacy/state/orders/actions'
import { useOrder } from 'legacy/state/orders/hooks'

import { ExternalLinkCustom } from './styled'

const OPHIS_FORK_CHAINS: ReadonlyArray<number> = [10 /* Optimism mainnet */]

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

  // Ophis fork (Finding B, 2026-05-20): on chains where we don't ship a
  // CoW-style explorer, the legacy fallback `getEtherscanLink('transaction',
  // orderUid)` produces a misleading URL — CoW order UIDs are 56 bytes with
  // the owner address embedded in bytes 32-52, so Etherscan silently
  // redirects the malformed "tx hash" to the embedded owner's address page.
  // Result: a fulfilled swap whose post-processor hasn't yet populated the
  // trade row links to the *user's* address instead of the settlement tx.
  // Suppress the link entirely on Ophis chains until the real tx hash is
  // available — `useSettlementTxHash` polls at 8s so the link appears
  // within one tick of post-processing.
  if (!ethFlowHash && !settlementTxHash && OPHIS_FORK_CHAINS.includes(chainId)) {
    return null
  }

  const linkTarget = ethFlowHash ?? settlementTxHash ?? id
  const href = ethFlowHash
    ? getBlockExplorerUrl(chainId, 'transaction', ethFlowHash)
    : (settlementTxHash
        ? getBlockExplorerUrl(chainId, 'transaction', settlementTxHash)
        : getEtherscanLink(chainId, 'transaction', id)) + (leadToBridgeTab ? '?tab=bridge' : '')
  const label = getExplorerLabel(chainId, 'transaction', linkTarget)

  return <ExternalLinkCustom href={href}>{label} ↗</ExternalLinkCustom>
}
