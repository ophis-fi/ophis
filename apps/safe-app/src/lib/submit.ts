import { Interface } from 'ethers';
import type SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { assertReceiverIsOwner, buildOphisOrderCreation, getOphisVaultRelayer } from '@ophis/sdk';
import { assertUidMatches, buildPresignTxBatch } from '@ophis/safe-swap';
import { ophisOrderBook } from './quote';
import { assertErc20Token } from './tokens';
import { WETH_DEPOSIT_IFACE } from './weth';
import { enrollTrackedWallet } from './tracking';
import type { QuotedOrder } from './order';

// Minimal ERC-20 surface for the allowance read (the approvals themselves are built by the
// shared @ophis/safe-swap batch builder).
const ERC20_ALLOWANCE_IFACE = new Interface(['function allowance(address,address) view returns (uint256)']);

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
  fullAppData: string,
  appDataHash: string,
  // True when the user is selling NATIVE ETH: prepend a WETH.deposit{value} so the Safe wraps its
  // own ETH to WETH in the SAME execution, then sells WETH. order.sellToken is already WETH and the
  // order owner stays the Safe, so the owner-scoped rebate indexer attributes it normally.
  wrapNative = false,
): Promise<SubmitResult> {
  assertReceiverIsOwner(owner, order.receiver); // drain guard before any tx
  // Belt-and-suspenders: the approval path below targets order.sellToken, so it must be a real
  // ERC-20 — never a native-ETH sentinel / zero address. For a wrapNative sell this is WETH (the
  // form mapped native -> WETH before quoting); for an ERC-20 sell it's the token itself. Either
  // way a degenerate quote echoing a sentinel/zero back must not reach an approve() to a non-token.
  assertErc20Token(order.sellToken, 'Sell token');

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

  // 1) Create the order in PRESIGNATURE_PENDING via the shared wire-body builder (validates the
  //    appDataHash, asserts the SIGNED order.appData matches it, and drain-guards the receiver).
  //    For presign the "signature" is the owner address.
  const body = buildOphisOrderCreation({
    order: order as unknown as Record<string, unknown>,
    owner,
    fullAppData,
    appDataHash,
    signature: owner,
    signingScheme: 'presign',
  } as never);
  const hostUid = (await api.sendOrder(body as never)) as unknown as string;
  // CRITICAL (guard parity with the headless vault builder): never trust the host's uid.
  // Re-derive it from the locally guarded order and refuse to presign anything else — a
  // compromised orderbook could return a DIFFERENT order's uid to redirect the presign.
  const orderUid = assertUidMatches(hostUid, order, chainId, owner);

  // 2) The relayer pulls the signed sellAmount + feeAmount. Since the guard-parity refactor the
  //    order signs the GROSS as sellAmount with feeAmount '0', so this equals the before-fee total
  //    the user asked to sell (identical value to the previous net + fee split).
  const pullAmount = BigInt(order.sellAmount) + BigInt(order.feeAmount);
  const txs: { to: string; value: string; data: string }[] = [];

  // Native-ETH sell: wrap FIRST, in this same execution. order.sellToken is the WETH address (the
  // quote was taken in WETH) and pullAmount is exactly the WETH settlement pulls, so deposit that
  // much native ETH. The Safe must hold >= pullAmount native ETH; the wrap + the approve below +
  // the presign all execute under ONE owner signature.
  if (wrapNative) {
    txs.push({ to: order.sellToken, value: pullAmount.toString(), data: WETH_DEPOSIT_IFACE.encodeFunctionData('deposit') });
  }

  let currentAllowance: bigint | null;
  try {
    const relayer = getOphisVaultRelayer(chainId);
    const allowanceData = ERC20_ALLOWANCE_IFACE.encodeFunctionData('allowance', [owner, relayer]);
    const raw = await sdk.eth.call([{ to: order.sellToken, data: allowanceData }]);
    [currentAllowance] = ERC20_ALLOWANCE_IFACE.decodeFunctionResult('allowance', raw) as unknown as [bigint];
  } catch (e) {
    // Allowance read failed (RPC hiccup, odd token): treat the current allowance as UNKNOWN and
    // approve defensively below (a redundant approve is harmless; a missing one is unfillable).
    console.warn('[ophis] allowance read failed; approving defensively:', (e as Error).message);
    currentAllowance = null;
  }

  // 3) Build [approve?, setPreSignature] via the shared @ophis/safe-swap batch builder — the ONE
  //    hardened codepath (exact USDT-safe approve to the Ophis relayer, never MaxUint256, clamps a
  //    pre-existing oversized allowance, presign targets the Ophis settlement, never canonical CoW).
  const { txs: batchTxs } = buildPresignTxBatch({
    chainId,
    orderUid,
    sellToken: order.sellToken,
    pullAmount,
    currentAllowance,
  });
  txs.push(...batchTxs);

  // 4) Propose the (wrap? + approve? + presign) batch to the Safe queue; owners co-sign + execute
  //    in the UI.
  const { safeTxHash } = await sdk.txs.send({ txs });
  return { orderUid, safeTxHash, enrollmentWarning };
}
