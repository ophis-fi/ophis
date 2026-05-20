import { ReactNode } from 'react'

import { getBlockExplorerUrl, getEtherscanLink, getExplorerLabel } from '@cowprotocol/common-utils'

import { useSettlementTxHash } from 'ophis/hooks/useSettlementTxHash'

import { OrderStatus } from 'legacy/state/orders/actions'
import { useOrder } from 'legacy/state/orders/hooks'

import { ExternalLinkCustom } from './styled'

// Allow-list of chains that have a CoW-style order explorer that accepts
// CoW order UIDs (114-char hex) as the explorer path. NEW chains default to
// "no working order explorer" — safer footprint: shipping a new chain
// without updating this list shows no link rather than a misleading one.
//
// Audit (sharp-edges + codex, 2026-05-20): the previous shape was a
// deny-list (OPHIS_FORK_CHAINS) which fails open — adding a new Ophis chain
// without remembering to update the list silently regresses to the
// owner-address-redirect bug. Inverted per their recommendation.
const CHAINS_WITH_COW_ORDER_EXPLORER: ReadonlyArray<number> = [
  1, // Ethereum mainnet — explorer.cow.fi/orders/<uid>
  100, // Gnosis Chain
  11155111, // Sepolia
  42161, // Arbitrum One
  8453, // Base
  // NOT: 10 (Optimism / Ophis fork), 4326 (MegaETH testnet), 999 (HyperEVM)
  // — these are Ophis-deployed chains without a CoW explorer yet (task #99).
]

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
  // Suppress the link entirely when we don't have a usable tx hash AND the
  // chain doesn't have a CoW order explorer. `useSettlementTxHash` polls at
  // 8s so the real link appears within one tick of post-processing.
  if (!ethFlowHash && !settlementTxHash && !CHAINS_WITH_COW_ORDER_EXPLORER.includes(chainId)) {
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
