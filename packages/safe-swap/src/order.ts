/**
 * Pure, security-critical order assembly + presign tx batch for the Ophis Safe
 * (vault) swap builder. No network, no cow-sdk import: these functions hold the
 * invariants (receiver pin, feeAmount 0, request binding, exact USDT-safe
 * approve, Ophis-not-canonical settlement) and are unit-tested in isolation.
 * The network orchestration (quote + sendOrder) lives in build.ts.
 */
import { encodeFunctionData, getAddress, hashTypedData } from 'viem';
import {
  assertReceiverIsOwner,
  getOphisOrderDomain,
  getOphisSettlementAddress,
  getOphisVaultRelayer,
  ophisOrderReceiver,
} from '@ophis/sdk';
import {
  applySlippage,
  assertBuyFloor,
  assertRequestBound,
  assertSignedFeeZero,
  assertSlippageBps,
} from './guards.js';

type Hex = `0x${string}`;
type Address = `0x${string}`;

/** Fill-or-kill TTL for a vault rebalance order (30 min), set locally, never trusted from the quote. */
export const ORDER_TTL_SECONDS = 30 * 60;

export interface TxCall {
  to: Address;
  value: string;
  data: Hex;
}

/** The hardened order the Safe presigns (kind is the CoW 'sell' literal). */
export interface VaultOrder {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string;
  feeAmount: '0';
  kind: 'sell';
  partiallyFillable: false;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
}

const ERC20_APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
const SET_PRESIGNATURE_ABI = [
  { type: 'function', name: 'setPreSignature', stateMutability: 'nonpayable', inputs: [{ type: 'bytes' }, { type: 'bool' }], outputs: [] },
] as const;

const encodeApprove = (spender: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [spender, amount] });
const encodeSetPreSignature = (orderUid: string): Hex =>
  encodeFunctionData({ abi: SET_PRESIGNATURE_ABI, functionName: 'setPreSignature', args: [orderUid as Hex, true] });

// The canonical GPv2 (CoW) Order EIP-712 type set (protocol constant, fixed by
// the settlement contract on every chain). Mirrors packages/agent-swap/src/order-types.ts
// (the constant used for real EOA signing), so the digest below matches what the
// orderbook computes. It must match exactly or the uid never matches.
const GPV2_ORDER_EIP712_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

/**
 * Compute the CoW orderUid locally from the assembled order:
 *   uid = orderDigest(32) ++ owner(20) ++ validTo(4, uint32 big-endian)  [56 bytes]
 * where orderDigest is the EIP-712 hash over getOphisOrderDomain(chainId). This
 * is deterministic from the (guarded) order, so it does NOT trust the orderbook.
 */
export function computeOrderUid(order: VaultOrder, chainId: number, owner: Address): Hex {
  const domain = getOphisOrderDomain(chainId) as {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  const digest = hashTypedData({
    domain,
    types: GPV2_ORDER_EIP712_TYPES,
    primaryType: 'Order',
    message: {
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: BigInt(order.sellAmount),
      buyAmount: BigInt(order.buyAmount),
      validTo: order.validTo,
      appData: order.appData as Hex,
      feeAmount: BigInt(order.feeAmount),
      kind: order.kind,
      partiallyFillable: order.partiallyFillable,
      sellTokenBalance: order.sellTokenBalance,
      buyTokenBalance: order.buyTokenBalance,
    },
  });
  const validToHex = (order.validTo >>> 0).toString(16).padStart(8, '0');
  return (`0x${digest.slice(2)}${owner.slice(2).toLowerCase()}${validToHex}`) as Hex;
}

/**
 * CRITICAL request-binding: the orderbook's setPreSignature target order is
 * identified only by uid. A compromised host could return a DIFFERENT order's
 * uid (owner == the Safe, but attacker receiver / amounts) so the curator
 * presigns a drain that the local order guards never saw. Bind the uid to the
 * locally assembled order: recompute it and refuse to presign anything else.
 * Returns the trusted (locally computed) uid to presign.
 */
export function assertUidMatches(hostUid: string, order: VaultOrder, chainId: number, owner: Address): Hex {
  const local = computeOrderUid(order, chainId, owner);
  if (typeof hostUid !== 'string' || hostUid.toLowerCase() !== local.toLowerCase()) {
    throw new Error(
      `orderbook returned a uid that does not match the locally computed order uid; refusing to presign ` +
        `(host ${hostUid}, expected ${local})`,
    );
  }
  return local;
}

/**
 * PURE: assemble the hardened order from a quote, enforcing every request-binding
 * invariant. `nowSeconds` is injected so validTo is deterministically testable.
 */
export function assembleVaultOrder(a: {
  safe: Address;
  quoteSellToken: string;
  quoteBuyToken: string;
  quoteSellAmount: string;
  quoteFeeAmount: string;
  quoteBuyAmount: string;
  requestedSellToken: Address;
  requestedBuyToken: Address;
  requestedGross: bigint;
  appDataHash: string;
  slippageBps: number;
  ttlSeconds: number;
  nowSeconds: number;
  /** Optional caller (curator) hard minimum-out, atomic units. */
  minBuyAmount?: bigint;
}): VaultOrder {
  assertSlippageBps(a.slippageBps);

  // Cast to the local Address alias: an optional adapter (exec-safe) pulls
  // protocol-kit's bundled viem into the type program, so viem's own Address can
  // resolve ambiguously across the two viem copies. getAddress returns a
  // checksummed address, so pinning it to the local `0x${string}` is sound.
  const sellToken = getAddress(a.quoteSellToken) as Address;
  const buyToken = getAddress(a.quoteBuyToken) as Address;
  const receiver = ophisOrderReceiver(a.safe) as Address;
  assertReceiverIsOwner(a.safe, receiver); // drain guard: receiver must be the Safe

  // CoW sell quotes split sellAmountBeforeFee into (net sellAmount, feeAmount);
  // their sum is the gross the caller asked for. We sign the gross, feeAmount 0.
  const grossSell = BigInt(a.quoteSellAmount) + BigInt(a.quoteFeeAmount);
  const minBuyAmount = applySlippage(BigInt(a.quoteBuyAmount), a.slippageBps);

  const order: VaultOrder = {
    sellToken,
    buyToken,
    receiver,
    sellAmount: grossSell.toString(),
    buyAmount: minBuyAmount.toString(),
    validTo: a.nowSeconds + a.ttlSeconds,
    appData: a.appDataHash,
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  };

  // Guards (fail-closed): a hostile quote host cannot change what the Safe pulls.
  assertSignedFeeZero(order.feeAmount);
  assertRequestBound({
    requestedSellToken: a.requestedSellToken,
    requestedBuyToken: a.requestedBuyToken,
    requestedGross: a.requestedGross,
    quoteSellToken: sellToken,
    quoteBuyToken: buyToken,
    quoteGross: grossSell,
  });
  assertBuyFloor(BigInt(order.buyAmount), a.minBuyAmount);

  return order;
}

/**
 * PURE: build the [approve?, setPreSignature] tx batch. `currentAllowance` null
 * means unknown -> approve defensively. approve is EXACT (never MaxUint256) and
 * resets USDT-style non-zero allowances to 0 first. setPreSignature targets the
 * Ophis (non-canonical) settlement; the approve spender is the Ophis relayer.
 */
export function buildPresignTxBatch(args: {
  chainId: number;
  orderUid: string;
  sellToken: Address;
  pullAmount: bigint;
  currentAllowance: bigint | null;
  /**
   * Escape hatch (default false). When true, an allowance that is ALREADY >=
   * pullAmount is left untouched (approve only when it is below), the old
   * top-up behaviour. Use ONLY when the Safe deliberately keeps ONE shared
   * relayer allowance funding several CONCURRENT presigned orders, where the
   * least-privilege clamp would shrink the allowance the other orders still
   * need. For a normal sequential rebalance leave it false (least-privilege).
   */
  keepSufficientAllowance?: boolean;
}): { txs: TxCall[]; settlement: Address; relayer: Address } {
  const settlement = getOphisSettlementAddress(args.chainId) as Address;
  const relayer = getOphisVaultRelayer(args.chainId) as Address;
  const txs: TxCall[] = [];

  // Default (least-privilege invariant #5): skip the approve ONLY when the Safe's
  // allowance is ALREADY EXACTLY pullAmount. Anything else — too low, OR a
  // pre-existing oversized/MaxUint allowance — is reset to 0 (USDT-safe) then
  // exact-approved, so no stale over-allowance to the relayer survives. With
  // keepSufficientAllowance, only a BELOW-pullAmount allowance is topped up.
  const needsApprove = args.keepSufficientAllowance
    ? args.currentAllowance === null || args.currentAllowance < args.pullAmount
    : args.currentAllowance === null || args.currentAllowance !== args.pullAmount;
  if (needsApprove) {
    if (args.currentAllowance === null || args.currentAllowance > 0n) {
      txs.push({ to: args.sellToken, value: '0', data: encodeApprove(relayer, 0n) });
    }
    txs.push({ to: args.sellToken, value: '0', data: encodeApprove(relayer, args.pullAmount) });
  }
  txs.push({ to: settlement, value: '0', data: encodeSetPreSignature(args.orderUid) });

  return { txs, settlement, relayer };
}
