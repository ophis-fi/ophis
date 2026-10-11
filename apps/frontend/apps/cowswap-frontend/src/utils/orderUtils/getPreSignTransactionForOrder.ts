import { LAUNCH_DARKLY_VIEM_MIGRATION } from '@cowprotocol/common-const'
import type { SupportedChainId } from '@cowprotocol/cow-sdk'
import type { JsonRpcSigner } from '@ethersproject/providers'

import { tradingSdk } from 'tradingSdk/tradingSdk'

/**
 * Builds the presign tx on the chain snapshotted before posting, not the SDK's mutable trader defaults
 * (which follow wallet/network switches). Env and settlementContractOverride still come from the SDK defaults.
 * The viem adapter cannot wrap an ethers signer (createSigner would overwrite its account), so it keeps its own.
 */
export function getPreSignTransactionForOrder(
  orderUid: string,
  chainId: SupportedChainId,
  signer: JsonRpcSigner,
): ReturnType<typeof tradingSdk.getPreSignTransaction> {
  return tradingSdk.getPreSignTransaction({
    orderUid,
    chainId,
    ...(LAUNCH_DARKLY_VIEM_MIGRATION ? {} : { signer }),
  })
}
