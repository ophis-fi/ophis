/**
 * Native-ETH support for Ophis integrators via the CoW Protocol eth-flow path.
 *
 * WHY THIS EXISTS: a standard CoW intent sells an ERC-20 token. To sell NATIVE
 * ETH the user instead calls the on-chain `CoWSwapEthFlow` contract's payable
 * `createOrder(...)`, which wraps the ETH to WETH and places + EIP-1271-signs a
 * GPv2 order on the user's behalf. Without this, an aggregator integrating
 * `@ophis/sdk` has no way to route a native-ETH sell through Ophis and must show
 * "wrap to WETH first" (i.e. Ophis is unavailable on the most common L2 sell
 * flow). This module gives integrators the verified per-chain eth-flow address,
 * the `createOrder` ABI, and a builder that assembles the on-chain order struct
 * with the Ophis partner-fee + referrer appData embedded, so native-ETH trades
 * still carry the Ophis fee.
 *
 * SOURCE OF TRUTH for the addresses (kept in lockstep with the frontend):
 *   - apps/frontend/libs/common-const/src/common.ts `OPHIS_ETHFLOW_OVERRIDES`
 *     (Ophis-operated chains: OP 10, HyperEVM 999; MegaETH 4326 disabled)
 *   - @cowprotocol/sdk-config `ETH_FLOW_ADDRESSES` (canonical CoW eth-flow,
 *     CREATE2-deterministic across CoW's SupportedChainId set)
 *   - the on-chain struct + selector: the CoWSwapEthFlow `createOrder` ABI
 *     `createOrder((address,address,uint256,uint256,bytes32,uint256,uint32,bool,int64))`
 *   - the value + fee semantics: @cowprotocol/sdk-trading sets the struct
 *     `feeAmount` to 0 and sends `msg.value = sellAmount` (the contract enforces
 *     the exact amount, reverting with `IncorrectEthAmount` otherwise).
 *
 * This module is dependency-free: it does NOT import cow-sdk, ethers, or viem.
 * It returns plain data (addresses, a bigint value, the order struct/tuple, and
 * the ABI) that the integrator passes to their own contract library.
 */

import { assertValidChainId, assertAddressLike, assertBytes32, isZeroAddress, addressesEqual } from './guards.js';
import { ophisOrderReceiver, type ReceiverOptions } from './order.js';

/**
 * Ophis-deployed eth-flow contracts on the self-hosted / Ophis-operated chains.
 * These are NOT the canonical CoW addresses: they are wired to the Ophis
 * settlement, so a native-ETH sell on these chains MUST go to the Ophis address.
 *   - 10  Optimism: deployed 2026-06-07, indexed by the Ophis autopilot. VERIFIED LIVE.
 *   - 999 HyperEVM: deployed (PR #61) + sdk patch (PR #65).
 * MegaETH (4326) has NO eth-flow contract deployed and is intentionally absent
 * (native ETH unsupported there; the integrator must wrap to WETH).
 */
const OPHIS_OPERATED_ETHFLOW: Readonly<Record<number, `0x${string}`>> = {
  10: '0x764fE4aa1FF493cf39931c7923C8ff5837596504',
  999: '0xd031Ce1C577caD1530BD8283CaA6a6a106A5b61B',
};

/**
 * Canonical CoW eth-flow proxy (prod). CREATE2-deterministic, so it is the same
 * address on every chain in CoW's `SupportedChainId` set that Ophis also serves.
 * Mirrors @cowprotocol/sdk-config `ETH_FLOW_ADDRESS`.
 */
const CANONICAL_COW_ETHFLOW = '0xba3cb449bd2b4adddbc894d8697f5170800eadec' as const;

/**
 * CoW-hosted chains (cow-sdk `SupportedChainId` members) where the canonical
 * eth-flow proxy is deployed. Same set as the SDK's fee chains minus the
 * Ophis-operated ones. Update in lockstep with cow-sdk's SupportedChainId.
 */
const CANONICAL_ETHFLOW_CHAIN_IDS = [
  1, 56, 100, 137, 8453, 9745, 42161, 43114, 57073, 59144, 11155111,
] as const;

/**
 * Build the per-chain map on a NULL-PROTOTYPE object so a bracket read for an
 * unsupported chain returns `undefined` even if `Object.prototype` is polluted
 * (a polluted numeric key must never resolve native ETH to an attacker address).
 * Ophis-operated overrides win over any canonical entry.
 */
const buildEthFlowMap = (): Record<number, `0x${string}`> => {
  const map = Object.create(null) as Record<number, `0x${string}`>;
  for (const id of CANONICAL_ETHFLOW_CHAIN_IDS) map[id] = CANONICAL_COW_ETHFLOW;
  for (const [id, addr] of Object.entries(OPHIS_OPERATED_ETHFLOW)) map[Number(id)] = addr;
  return map;
};

/**
 * Frozen, immutable, null-prototype per-chain eth-flow address map. A chain
 * absent from this map does NOT support native-ETH via Ophis (the integrator
 * must wrap to WETH and use the ordinary `buildOphisOrderCreation` path).
 */
export const OPHIS_ETHFLOW_ADDRESSES: Readonly<Record<number, `0x${string}`>> = Object.freeze(buildEthFlowMap());

/** True if Ophis supports native-ETH (eth-flow) on this chain. */
export const isOphisEthFlowChain = (chainId: number): boolean => {
  assertValidChainId(chainId);
  return Object.prototype.hasOwnProperty.call(OPHIS_ETHFLOW_ADDRESSES, chainId);
};

/**
 * The eth-flow contract address for a chain, or `undefined` if native ETH is
 * not supported there (wrap to WETH instead). Throws on an invalid chainId.
 * Uses an own-property check so a polluted prototype cannot make this return a
 * forged address for an unsupported chain (fail-closed).
 */
export const getOphisEthFlowAddress = (chainId: number): `0x${string}` | undefined => {
  assertValidChainId(chainId);
  return Object.prototype.hasOwnProperty.call(OPHIS_ETHFLOW_ADDRESSES, chainId)
    ? OPHIS_ETHFLOW_ADDRESSES[chainId]
    : undefined;
};

/**
 * The CoWSwapEthFlow `createOrder` ABI fragment (JSON form, ethers/viem ready).
 * Selector: `createOrder((address,address,uint256,uint256,bytes32,uint256,uint32,bool,int64))`,
 * payable, returns the order hash (bytes32). Field ORDER is significant: it is
 * the on-chain `EthFlowOrder.Data` struct order, mirrored by `ethFlowOrderToTuple`.
 */
export const ETHFLOW_CREATE_ORDER_ABI = Object.freeze([
  {
    type: 'function',
    name: 'createOrder',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'buyToken', type: 'address' },
          { name: 'receiver', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'buyAmount', type: 'uint256' },
          { name: 'appData', type: 'bytes32' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'validTo', type: 'uint32' },
          { name: 'partiallyFillable', type: 'bool' },
          { name: 'quoteId', type: 'int64' },
        ],
      },
    ],
    outputs: [{ name: 'orderHash', type: 'bytes32' }],
  },
] as const);

/**
 * Human-readable form of the same ABI, for `ethers.Interface` / viem `parseAbi`.
 */
export const ETHFLOW_CREATE_ORDER_ABI_HUMAN =
  'function createOrder((address buyToken, address receiver, uint256 sellAmount, uint256 buyAmount, bytes32 appData, uint256 feeAmount, uint32 validTo, bool partiallyFillable, int64 quoteId) order) payable returns (bytes32 orderHash)';

/** The on-chain `EthFlowOrder.Data` struct an integrator passes to `createOrder`. */
export interface EthFlowOrderData {
  /** The ERC-20 the user receives. NOT the native sentinel and NOT WETH-as-native. */
  readonly buyToken: `0x${string}`;
  /** The recipient of the bought tokens. A real, non-zero address (the taker by default). */
  readonly receiver: `0x${string}`;
  /** Native ETH sold, in wei. Equal to `msg.value`. */
  readonly sellAmount: bigint;
  /** Minimum tokens to buy (the limit), in atoms. */
  readonly buyAmount: bigint;
  /** keccak256 of the full appData JSON (carries the Ophis partnerFee + referrer). */
  readonly appData: `0x${string}`;
  /** Always 0 in modern eth-flow: the partner fee lives in appData, not on-chain. */
  readonly feeAmount: bigint;
  /** uint32 expiry (unix seconds). */
  readonly validTo: number;
  /** eth-flow orders are fill-or-kill; this is false. */
  readonly partiallyFillable: boolean;
  /** The quote id (int64) from the CoW quote response. */
  readonly quoteId: number;
}

/**
 * The `EthFlowOrder.Data` struct as a positional tuple. CONSTRUCT ONLY via
 * `ethFlowOrderToTuple` or the builder's returned `orderTuple`: the two address
 * slots and the two amount slots are type-compatible, so a hand-written literal
 * can transpose them with no type error.
 */
export type EthFlowOrderTuple = readonly [
  `0x${string}`, `0x${string}`, bigint, bigint, `0x${string}`, bigint, number, boolean, number,
];

export interface OphisEthFlowParams extends ReceiverOptions {
  readonly chainId: number;
  readonly buyToken: `0x${string}`;
  /**
   * The taker (the wallet that sends the createOrder tx). The `receiver` is
   * pinned to this by default; pass `unsafeCustomReceiver` to send proceeds
   * elsewhere (a deliberate, named opt-in, as on the ERC-20 path).
   */
  readonly owner: `0x${string}`;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  /**
   * The FULL appData JSON string, built with `buildOphisOrderMetadata` +
   * cow-sdk's `generateAppDataDoc` + `stringifyDeterministic`. It MUST be
   * uploaded to the orderbook (PUT /app_data/{hash}) so solvers honor the
   * Ophis partner fee; the on-chain order only commits the hash.
   */
  readonly fullAppData: string;
  /** keccak256(toUtf8Bytes(fullAppData)) as bytes32. */
  readonly appDataHash: `0x${string}`;
  /** uint32 expiry (unix seconds). */
  readonly validTo: number;
  /** The quote id (int64) from the CoW quote response. */
  readonly quoteId: number;
  /**
   * Optional keccak256 function, e.g. `(s) => keccak256(toUtf8Bytes(s))`. When
   * supplied, the builder VERIFIES `appDataHash === hashAppData(fullAppData)`
   * and throws on mismatch (fail-closed: a stale hash would silently drop the
   * partner fee and commit ETH against an appData the orderbook cannot resolve).
   * When omitted, `appDataHash` is TRUSTED, not verified.
   */
  readonly hashAppData?: (fullAppData: string) => string;
}

export interface OphisEthFlowOrder {
  /** The eth-flow contract to call `createOrder` on. */
  readonly ethFlowContract: `0x${string}`;
  /** The ETH (wei) to send as `msg.value`: equal to `sellAmount` (eth-flow feeAmount is 0). */
  readonly value: bigint;
  /** The `EthFlowOrder.Data` struct for `createOrder`. */
  readonly order: EthFlowOrderData;
  /** The struct as an ordered tuple, matching the ABI component order exactly. */
  readonly orderTuple: EthFlowOrderTuple;
  /** The `createOrder` ABI fragment (JSON form). */
  readonly abi: typeof ETHFLOW_CREATE_ORDER_ABI;
  /**
   * The full appData JSON the integrator MUST upload to the orderbook BEFORE or
   * alongside submitting the order, or the partner fee will not be applied and
   * Ophis earns nothing on the trade.
   */
  readonly appDataToUpload: string;
}

const UINT32_MAX = 4_294_967_295;

const assertPositiveBigint = (value: unknown, label: string): void => {
  if (typeof value !== 'bigint') {
    throw new TypeError(`Ophis: ${label} must be a bigint (wei/atoms), received ${typeof value}.`);
  }
  if (value <= 0n) {
    throw new RangeError(`Ophis: ${label} must be > 0, received ${value.toString()}.`);
  }
};

/**
 * Returns the `EthFlowOrder.Data` struct as an ordered tuple in the exact ABI
 * component order. Use this instead of hand-ordering fields: a transposed
 * field (e.g. swapping sellAmount and buyAmount) silently mis-prices the order.
 */
export const ethFlowOrderToTuple = (o: EthFlowOrderData): EthFlowOrderTuple =>
  [o.buyToken, o.receiver, o.sellAmount, o.buyAmount, o.appData, o.feeAmount, o.validTo, o.partiallyFillable, o.quoteId] as const;

/**
 * Builds everything an integrator needs to place a NATIVE-ETH Ophis order via
 * the on-chain eth-flow `createOrder`, with the Ophis partner-fee + referrer
 * appData embedded so the trade still earns the fee.
 *
 * The integrator then: (1) uploads `appDataToUpload` to the orderbook, and
 * (2) calls `createOrder(orderTuple)` on `ethFlowContract` with `value`.
 *
 * Throws (loudly, never silently mis-builds) when:
 *   - the chain does not support native ETH via Ophis (wrap to WETH instead);
 *   - the resolved `receiver` is the zero address (would send funds to the contract);
 *   - `appDataHash` is not bytes32, or (when `hashAppData` is given) does not match `fullAppData`;
 *   - `buyToken`/`owner`/`unsafeCustomReceiver` are not addresses;
 *   - `sellAmount`/`buyAmount` are not positive bigints; `validTo` is out of uint32 range;
 *   - `quoteId` is not a safe non-negative integer.
 *
 * @example
 *   // appData built with the Ophis helpers (carries the partner fee + referrer):
 *   const doc = await new MetadataApi().generateAppDataDoc(
 *     buildOphisOrderMetadata({ chainId, referralCode: 'yourcode', isStablePair }),
 *   );
 *   const fullAppData = await stringifyDeterministic(doc);
 *   const appDataHash = keccak256(toUtf8Bytes(fullAppData));
 *   const built = buildOphisEthFlowOrder({
 *     chainId, buyToken, owner, sellAmount, buyAmount,
 *     fullAppData, appDataHash, validTo, quoteId,
 *     hashAppData: (s) => keccak256(toUtf8Bytes(s)), // optional: verify the hash binds
 *   });
 *   await orderBookApi.uploadAppData(appDataHash, built.appDataToUpload); // step 1
 *   await ethFlow.createOrder(built.orderTuple, { value: built.value });  // step 2
 */
export function buildOphisEthFlowOrder(params: OphisEthFlowParams): OphisEthFlowOrder {
  const { chainId, buyToken, owner, sellAmount, buyAmount, fullAppData, appDataHash, validTo, quoteId, hashAppData } = params;

  const ethFlowContract = getOphisEthFlowAddress(chainId);
  if (ethFlowContract === undefined) {
    throw new Error(
      `Ophis: native ETH is not supported on chain ${chainId} via eth-flow. ` +
        'Wrap the ETH to WETH and use the ordinary buildOphisOrderCreation path instead.',
    );
  }

  assertAddressLike(buyToken, 'buyToken');

  // Pin the receiver to the taker by default; a non-owner receiver is a named,
  // deliberate opt-in (parity with the ERC-20 order.ts / flow.ts receiver guard).
  const receiver = ophisOrderReceiver(owner, { unsafeCustomReceiver: params.unsafeCustomReceiver });
  // A zero receiver in a normal CoW order means "send to owner". For eth-flow the
  // owner is the contract, so a zero receiver would deliver the bought tokens to
  // the eth-flow contract. Require an explicit, real recipient.
  if (isZeroAddress(receiver)) {
    throw new Error(
      'Ophis: eth-flow receiver must be the actual recipient (a non-zero address). ' +
        'A zero receiver would send the bought tokens to the eth-flow contract.',
    );
  }

  assertBytes32(appDataHash, 'appDataHash');

  if (typeof fullAppData !== 'string' || fullAppData.length === 0) {
    throw new TypeError(
      'Ophis: fullAppData must be the non-empty appData JSON string (it must be uploaded to the orderbook ' +
        'so the partner fee is honored). Build it with buildOphisOrderMetadata + generateAppDataDoc.',
    );
  }

  // Optional fail-closed binding: when the integrator passes a hasher, prove the
  // committed hash is the keccak of the JSON we return for upload. A mismatch
  // would silently drop the partner fee and commit ETH against an unresolvable
  // appData, so refuse to build it.
  if (hashAppData !== undefined) {
    const computed = hashAppData(fullAppData);
    assertBytes32(computed, 'hashAppData(fullAppData) result');
    if (!addressesEqual(computed, appDataHash)) {
      throw new Error(
        `Ophis: appDataHash (${appDataHash}) does not match keccak256(fullAppData) (${computed}). ` +
          'The on-chain order would commit a hash the uploaded appData does not resolve, dropping the partner fee.',
      );
    }
  }

  assertPositiveBigint(sellAmount, 'sellAmount');
  assertPositiveBigint(buyAmount, 'buyAmount');

  if (!Number.isInteger(validTo) || validTo <= 0 || validTo > UINT32_MAX) {
    throw new RangeError(`Ophis: validTo must be a uint32 unix timestamp (1..${UINT32_MAX}), received ${String(validTo)}.`);
  }
  if (!Number.isSafeInteger(quoteId) || quoteId < 0) {
    throw new RangeError(`Ophis: quoteId must be a safe non-negative integer (from the quote response), received ${String(quoteId)}.`);
  }

  const order: EthFlowOrderData = {
    buyToken,
    receiver,
    sellAmount,
    buyAmount,
    appData: appDataHash,
    feeAmount: 0n, // modern eth-flow: fee is always 0 on-chain; the partner fee rides in appData
    validTo,
    partiallyFillable: false, // eth-flow orders are always fill-or-kill
    quoteId,
  };

  return {
    ethFlowContract,
    value: sellAmount, // the contract enforces msg.value == sellAmount (IncorrectEthAmount otherwise)
    order,
    orderTuple: ethFlowOrderToTuple(order),
    abi: ETHFLOW_CREATE_ORDER_ABI,
    appDataToUpload: fullAppData,
  };
}
