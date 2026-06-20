import { Interface } from 'ethers';
import type SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { SigningScheme } from '@cowprotocol/cow-sdk';
import { getOphisSettlementAddress, assertReceiverIsOwner } from '@ophis/sdk';
import { ophisOrderBook } from './quote';
import { registerTrackedWallet } from './tracking';
import type { QuotedOrder } from './order';

const SETTLEMENT_IFACE = new Interface(['function setPreSignature(bytes orderUid, bool signed)']);

export async function submitOrder(
  sdk: SafeAppsSDK,
  chainId: number,
  owner: `0x${string}`,
  order: QuotedOrder,
  fullAppData: string,
  appDataHash: string,
): Promise<{ orderUid: string; safeTxHash: string }> {
  assertReceiverIsOwner(owner, order.receiver as `0x${string}`); // drain guard before any tx

  const api = ophisOrderBook(chainId);

  // 1) Create the order in PRESIGNATURE_PENDING. For presign the "signature" is the owner address.
  const orderUid: string = await api.sendOrder({
    ...(order as any),
    from: owner,
    appData: fullAppData,
    appDataHash,
    signingScheme: SigningScheme.PRESIGN,
    signature: owner,
  } as any);

  // Make sure the indexer will pull this Safe's trades (best-effort, never blocks the swap).
  void registerTrackedWallet(owner);

  // 2) Encode GPv2Settlement.setPreSignature(orderUid, true) against the OPHIS settlement address
  //    (OP is the non-canonical 0x310784c7...; the canonical address would bypass the Ophis fee).
  const to = getOphisSettlementAddress(chainId);
  const data = SETTLEMENT_IFACE.encodeFunctionData('setPreSignature', [orderUid, true]);

  // 3) Propose the single tx to the Safe queue; owners co-sign + execute in the Safe UI.
  const { safeTxHash } = await sdk.txs.send({ txs: [{ to, value: '0', data }] });
  return { orderUid, safeTxHash };
}
