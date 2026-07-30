import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { BasketDraft } from '../types'

/**
 * True when a draft belongs to the CURRENT wallet context: same composing
 * account AND same chain. Placement and cancellation guard on this so switching
 * wallet or network cannot place or cancel a basket that was composed under a
 * different account/chain (its legs, amounts and settlement chain no longer
 * apply). Address comparison via areAddressesEqual (never === / toLowerCase).
 */
export function isDraftForContext(
  draft: BasketDraft | null,
  owner: string | undefined,
  chainId: number | undefined,
): boolean {
  if (!draft || !owner || chainId === undefined) return false
  return draft.chainId === chainId && areAddressesEqual(draft.owner, owner)
}
