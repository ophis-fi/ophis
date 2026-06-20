import { Interface } from 'ethers';
import type SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { SigningScheme } from '@cowprotocol/cow-sdk';
import { getOphisSettlementAddress, getOphisVaultRelayer, assertReceiverIsOwner } from '@ophis/sdk';
import { ophisOrderBook } from './quote';
import { enrollTrackedWallet } from './tracking';
import type { QuotedOrder } from './order';

const SETTLEMENT_IFACE = new Interface(['function setPreSignature(bytes orderUid, bool signed)']);
// Minimal ERC-20 surface for the allowance read + the approval we may prepend.
const ERC20_ALLOWANCE_IFACE = new Interface(['function allowance(address,address) view returns (uint256)']);
const ERC20_APPROVE_IFACE = new Interface(['function approve(address,uint256)']);

export interface SubmitResult {
  orderUid: string;
  safeTxHash: string;
  // Set when rebate-indexer enrollment failed. The order STILL submitted (enrollment is not a
  // settlement precondition); the rebate may just not be tracked until the Safe is enrolled.
  enrollmentWarning?: string;
}

export async function submitOrder(
  sdk: SafeAppsSDK,
  chainId: number,
  owner: `0x${string}`,
  order: QuotedOrder,
  sellToken: string,
  sellAmount: string,
  fullAppData: string,
  appDataHash: string,
): Promise<SubmitResult> {
  assertReceiverIsOwner(owner, order.receiver as `0x${string}`); // drain guard before any tx

  const api = ophisOrderBook(chainId);

  // 0) Enroll the Safe with the rebate indexer BEFORE creating the order. enrollOphisTrader
  //    validates the address, enforces an https host, and THROWS on a non-2xx, so we await it
  //    and surface a VISIBLE non-blocking warning on failure rather than firing-and-forgetting.
  //    Enrollment is NOT a settlement precondition, so a failure must not abort the swap.
  let enrollmentWarning: string | undefined;
  try {
    await enrollTrackedWallet(owner);
  } catch (e) {
    enrollmentWarning = (e as Error).message;
    console.warn('[ophis] rebate-indexer enrollment failed; the rebate may not index:', enrollmentWarning);
  }

  // 1) Create the order in PRESIGNATURE_PENDING. For presign the "signature" is the owner address.
  const orderUid: string = await api.sendOrder({
    ...(order as any),
    from: owner,
    appData: fullAppData,
    appDataHash,
    signingScheme: SigningScheme.PRESIGN,
    signature: owner,
  } as any);

  // 2) Encode GPv2Settlement.setPreSignature(orderUid, true) against the OPHIS settlement address
  //    (OP is the non-canonical 0x310784c7...; the canonical address would bypass the Ophis fee).
  const settlement = getOphisSettlementAddress(chainId);
  const setPreSignatureData = SETTLEMENT_IFACE.encodeFunctionData('setPreSignature', [orderUid, true]);

  // 3) CoW settlement pulls the sell token via the GPv2VaultRelayer. On Ophis-operated chains
  //    that is the NON-canonical Ophis relayer (getOphisVaultRelayer, NOT cow-sdk's default), so a
  //    first-time seller whose Safe never approved it would have its order accepted but never
  //    filled. If the Safe's current allowance for the relayer is below the sell amount, PREPEND an
  //    ERC-20 approve into the SAME Safe execution so one signature does both (approve, presign).
  const relayer = getOphisVaultRelayer(chainId);
  const txs: { to: string; value: string; data: string }[] = [];

  let needsApprove: boolean;
  try {
    const allowanceData = ERC20_ALLOWANCE_IFACE.encodeFunctionData('allowance', [owner, relayer]);
    const raw = await sdk.eth.call([{ to: sellToken, data: allowanceData }]);
    const [allowance] = ERC20_ALLOWANCE_IFACE.decodeFunctionResult('allowance', raw) as unknown as [bigint];
    needsApprove = allowance < BigInt(sellAmount);
  } catch (e) {
    // If the allowance read fails (RPC hiccup, odd token), fall back to ALWAYS prepending an
    // approve: an extra (idempotent) approve is harmless, a missing one leaves the order unfillable.
    console.warn('[ophis] allowance read failed; prepending approve defensively:', (e as Error).message);
    needsApprove = true;
  }

  if (needsApprove) {
    // Least-privilege: approve exactly the sell amount (not MaxUint256) so a stale approval cannot
    // be drained by a later compromise of the relayer. The cost is one approval per first sell of
    // a token at/above this size.
    const approveData = ERC20_APPROVE_IFACE.encodeFunctionData('approve', [relayer, sellAmount]);
    txs.push({ to: sellToken, value: '0', data: approveData });
  }
  txs.push({ to: settlement, value: '0', data: setPreSignatureData });

  // 4) Propose the (approve? + presign) batch to the Safe queue; owners co-sign + execute in the UI.
  const { safeTxHash } = await sdk.txs.send({ txs });
  return { orderUid, safeTxHash, enrollmentWarning };
}
