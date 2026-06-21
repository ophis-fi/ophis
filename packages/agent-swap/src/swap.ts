import { OrderBookApi, SigningScheme, OrderQuoteSideKindSell } from '@cowprotocol/cow-sdk';
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/app-data';
import {
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  getOphisVaultRelayer,
  buildOphisOrderMetadata,
  buildOphisOrderCreation,
  enrollOphisTrader,
  ophisOrderReceiver,
  assertReceiverIsOwner,
  isOphisFeeChain,
} from '@ophis/sdk';
import { keccak256, toBytes, parseUnits, isAddress, getAddress as toChecksum } from 'viem';
import { GPV2_ORDER_EIP712_TYPES, GPV2_ORDER_PRIMARY_TYPE } from './order-types.js';
import type { Address, OphisAgentWallet } from './wallet.js';

// EIP-7528 native sentinel + the zero address. The EOA EIP-712 path is ERC-20 only; native-ETH
// sells need CoW eth-flow (owner becomes a contract, which also changes rebate attribution), so the
// agent must wrap to WETH instead. Reject both up front with a clear message.
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Autonomous-agent slippage ceiling (50%). At 100% the buy floor is 0 — an order that accepts any
// proceeds. There is no human reviewing an agent's tx, so an absurd slippage is rejected outright.
const MAX_SLIPPAGE_BPS = 5_000;

export interface OphisSwapParams {
  /** ERC-20 sell token address. */
  sellToken: string;
  /** ERC-20 buy token address. */
  buyToken: string;
  /** Amount of sellToken in WHOLE units (e.g. "1.5"); converted to base units via the token's decimals. */
  sellAmount: string;
  /** Max slippage in basis points; default 50 (0.5%). */
  slippageBps?: number;
}

export interface OphisSwapOptions {
  /** The integrator referral code that earns the 8-12% rebate (rides in the order's appData). */
  referralCode: string;
  /** Set true for stablecoin<>stablecoin pairs to apply the 1bp stable fee tier. */
  isStablePair?: boolean;
}

export interface OphisSwapResult {
  /** The CoW order UID; track it on the Ophis explorer. */
  orderUid: string;
  chainId: number;
  owner: string;
  sellToken: string;
  buyToken: string;
  /** The whole-unit sell amount as supplied. */
  sellAmount: string;
  /** The minimum buy amount (after slippage), in base units, that the order will accept. */
  minBuyAmount: string;
  explorerUrl: string;
  /** Set if rebate-indexer enrollment failed — the swap still submitted, but the rebate may not index. */
  enrollmentWarning?: string;
}

function assertErc20(addr: string, label: string): Address {
  if (!isAddress(addr)) throw new Error(`${label} is not a valid address: ${addr}`);
  const lower = addr.toLowerCase();
  if (lower === ZERO_ADDRESS || lower === NATIVE_SENTINEL) {
    throw new Error(
      `${label} is native ETH / the zero address. This agent path is ERC-20 only — sell WETH instead ` +
        `(native-ETH sells require CoW eth-flow, a separate path).`,
    );
  }
  return toChecksum(addr);
}

function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * Quote, sign (EIP-712), and submit an ERC-20 -> ERC-20 Ophis (CoW) swap from an agent's EOA wallet,
 * carrying the Ophis partner fee + referrer code in appData so the integrator earns the rebate.
 * Returns the order UID. The signature is produced by the framework wallet's `signTypedData`.
 */
export async function executeOphisSwap(
  wallet: OphisAgentWallet,
  params: OphisSwapParams,
  options: OphisSwapOptions,
): Promise<OphisSwapResult> {
  const chainId = wallet.getChainId();
  if (!isOphisFeeChain(chainId)) {
    throw new Error(`Ophis does not operate on chain ${chainId}; switch the agent to a supported chain.`);
  }
  if (!options.referralCode) throw new Error('Ophis referral code is required (it carries the rebate).');

  const owner = wallet.getAddress();
  const sellToken = assertErc20(params.sellToken, 'sellToken');
  const buyToken = assertErc20(params.buyToken, 'buyToken');
  const slippageBps = params.slippageBps ?? 50;
  // Cap well below 100%: at 10000 the buy floor would be 0 (an order that accepts ANY/zero proceeds
  // — a max-sandwich invitation). An unattended agent has no human reviewing the tx, so reject an
  // absurd slippage outright. MAX_SLIPPAGE_BPS = 5000 (50%) still allows very illiquid pairs.
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps out of range [0,${MAX_SLIPPAGE_BPS}]: ${slippageBps}`);
  }

  const decimals = await wallet.readErc20Decimals(sellToken);
  const sellAmountAtomic = parseUnits(params.sellAmount, decimals);
  if (sellAmountAtomic <= 0n) throw new Error(`sellAmount must be > 0: ${params.sellAmount}`);

  // Enroll the trader with the OWNER-SCOPED rebate indexer. Non-fatal: an enrollment hiccup must not
  // abort the swap; the rebate simply won't index until the wallet is enrolled.
  let enrollmentWarning: string | undefined;
  try {
    await enrollOphisTrader(owner);
  } catch (e) {
    enrollmentWarning = `rebate-indexer enrollment failed (swap still executes; rebate may not index): ${(e as Error).message}`;
  }

  // Build the fee-bearing appData (appCode 'ophis' + CIP-75 partner fee + ophisReferrer code) and
  // hash it. NON-validating path: ophisReferrer is an Ophis extension key CoW's strict schema rejects.
  const appDataInput = buildOphisOrderMetadata({ chainId, referralCode: options.referralCode, isStablePair: options.isStablePair });
  const appDataDoc = await new MetadataApi().generateAppDataDoc(appDataInput as never);
  const fullAppData = await stringifyDeterministic(appDataDoc as never);
  const appDataHash = keccak256(toBytes(fullAppData));

  // Quote against the OPHIS orderbook host (getOphisOrderbookUrl; hitting api.cow.fi directly drops the fee).
  const orderBookApi = new OrderBookApi({ chainId, baseUrls: { [chainId]: getOphisOrderbookUrl(chainId) } } as never);
  const receiver = ophisOrderReceiver(owner);
  const quoteRes = (await orderBookApi.getQuote({
    kind: OrderQuoteSideKindSell.SELL,
    sellToken,
    buyToken,
    sellAmountBeforeFee: sellAmountAtomic.toString(),
    from: owner,
    receiver,
    appData: appDataHash,
    appDataHash,
    signingScheme: SigningScheme.EIP712,
  } as never)) as { quote?: Record<string, unknown> } & Record<string, unknown>;
  const q = (quoteRes.quote ?? quoteRes) as Record<string, unknown>;

  // Assemble the order to sign. appData = the bytes32 HASH (this is what is signed). Slippage lowers
  // the buyAmount so the quoted price is a floor, not an exact requirement.
  const minBuyAmount = applySlippage(BigInt(String(q.buyAmount)), slippageBps).toString();
  const order = {
    sellToken: toChecksum(String(q.sellToken)),
    buyToken: toChecksum(String(q.buyToken)),
    receiver,
    sellAmount: String(q.sellAmount),
    buyAmount: minBuyAmount,
    validTo: Number(q.validTo),
    appData: appDataHash,
    feeAmount: String(q.feeAmount),
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  } as const;
  assertReceiverIsOwner(owner, receiver); // drain guard: the receiver must be the owner

  // Approve the OPHIS vault relayer for what settlement pulls (sellAmount NET + feeAmount = the gross).
  const relayer = getOphisVaultRelayer(chainId);
  const pullAmount = BigInt(order.sellAmount) + BigInt(order.feeAmount);
  await wallet.ensureErc20Allowance(sellToken, relayer, pullAmount);

  // Sign the order EIP-712 with the agent's EOA wallet (NOT presign — that is the smart-wallet path).
  const signature = await wallet.signTypedData({
    domain: getOphisOrderDomain(chainId) as unknown as Record<string, unknown>,
    types: GPV2_ORDER_EIP712_TYPES as unknown as OphisTypedDataTypes,
    primaryType: GPV2_ORDER_PRIMARY_TYPE,
    message: order as unknown as Record<string, unknown>,
  });

  // Submit. buildOphisOrderCreation produces the correct wire body (full appData STRING + the hash)
  // and asserts the signed order's appData equals the hash.
  const body = buildOphisOrderCreation({ order, owner, fullAppData, appDataHash, signature, signingScheme: 'eip712' } as never);
  const orderUid = (await orderBookApi.sendOrder(body as never)) as unknown as string;

  return {
    orderUid,
    chainId,
    owner,
    sellToken,
    buyToken,
    sellAmount: params.sellAmount,
    minBuyAmount,
    explorerUrl: `https://explorer.ophis.fi/orders/${orderUid}`,
    enrollmentWarning,
  };
}

type OphisTypedDataTypes = Record<string, ReadonlyArray<{ name: string; type: string }>>;
