import { LAUNCH_DARKLY_VIEM_MIGRATION } from '@cowprotocol/common-const'
import { getGlobalAdapter, type SupportedChainId, type TradingTransactionParams } from '@cowprotocol/cow-sdk'
import type { JsonRpcSigner } from '@ethersproject/providers'

import { tradingSdk } from 'tradingSdk/tradingSdk'

/**
 * Builds the presign tx on the chain snapshotted before posting, not the SDK's mutable trader defaults
 * (which follow wallet/network switches). Env and settlementContractOverride still come from the SDK defaults.
 * Viem must explicitly use its adapter signer: SDK defaults can retain an ethers signer from initialization.
 */
export async function getPreSignTransactionForOrder(
  orderUid: string,
  chainId: SupportedChainId,
  signer: JsonRpcSigner,
): Promise<TradingTransactionParams & { chainId: SupportedChainId }> {
  const transaction = await tradingSdk.getPreSignTransaction({
    orderUid,
    chainId,
    signer: LAUNCH_DARKLY_VIEM_MIGRATION ? getGlobalAdapter().signer : signer,
  })
  // The SDK omits chainId; bind the wallet request even if its network changes while posting.
  return { ...transaction, chainId }
}
