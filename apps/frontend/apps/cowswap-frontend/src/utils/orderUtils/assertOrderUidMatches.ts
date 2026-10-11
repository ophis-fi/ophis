import type { ContractsOrder, SupportedChainId, UnsignedOrder } from '@cowprotocol/cow-sdk'

import { computeOrderUid } from './computeOrderUid'

/**
 * Request-binding for presign flows: the orderbook identifies the order to presign only by its uid.
 * A compromised/malicious orderbook could return the uid of a DIFFERENT order (other receiver/amounts,
 * owner or signing domain), so recompute the uid from the locally reviewed order and refuse anything else.
 * Mirrors `assertUidMatches` from packages/safe-swap.
 */
export async function assertOrderUidMatches(
  orderId: string,
  unsignedOrder: UnsignedOrder,
  chainId: SupportedChainId,
  owner: string,
): Promise<void> {
  const expectedUid = await computeOrderUid(chainId, owner, unsignedOrder as ContractsOrder)

  if (typeof orderId !== 'string' || orderId.toLowerCase() !== expectedUid.toLowerCase()) {
    throw new Error(
      `Orderbook returned an order id that does not match the reviewed order; refusing to presign ` +
        `(received ${orderId}, expected ${expectedUid})`,
    )
  }
}
