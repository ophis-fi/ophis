/**
 * @ophis/safe-swap - headless Ophis (CoW Protocol) swap builder for a Safe (vault) trader.
 *
 * buildOphisSafePresign() lets a vault curator / manager (Zodiac Roles module, MPC signer,
 * or multisig) rebalance the vault's underlying: it quotes against the Ophis
 * orderbook, builds the fee-bearing appData, assembles a receiver-pinned order
 * with the hardened request-binding guards (see order.ts), POSTs it
 * PRESIGNATURE_PENDING to obtain the orderUid, and RETURNS the raw tx batch
 * [approve?, setPreSignature(uid, true)] plus the orderUid. Execution is left to
 * whatever curation layer the vault uses. The vault Safe is BOTH order.from and
 * order.receiver; funds never leave its control.
 *
 * Delivery-agnostic lift of apps/safe-app/src/lib/submit.ts (minus the iframe
 * @safe-global/safe-apps-sdk coupling), reusing @ophis/sdk order construction.
 */
import { OrderBookApi, OrderQuoteSideKindSell, SigningScheme } from '@cowprotocol/cow-sdk';
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/app-data';
import { getAddress, keccak256, toBytes } from 'viem';
import {
  buildOphisOrderCreation,
  buildOphisOrderMetadata,
  getOphisOrderbookUrl,
  getOphisVaultRelayer,
  ophisOrderReceiver,
} from '@ophis/sdk';
import { assertErc20, assertSlippageBps, DEFAULT_SLIPPAGE_BPS } from './guards.js';
import { assembleVaultOrder, assertUidMatches, buildPresignTxBatch, ORDER_TTL_SECONDS, type TxCall } from './order.js';

type Address = `0x${string}`;

export interface OphisSafePresignParams {
  chainId: number;
  /** The vault Safe: order.from AND order.receiver. */
  safe: Address;
  /** Underlying being sold (real ERC-20, checksummed or not). */
  sellToken: Address;
  /** Underlying being bought. */
  buyToken: Address;
  /** Gross amount to sell, in ATOMIC base units (wei), as a decimal string. */
  sellAmount: string;
  /**
   * Optional curator hard minimum-out (buy token, atomic units). The signed
   * order's buy floor must meet it or the build is refused, so a hostile quote
   * host cannot fill at a terrible-but-nonzero price. Recommended for any
   * meaningful size (the curator has its own NAV/valuation to source it from).
   */
  minBuyAmount?: string;
  /** Slippage tolerance; default 50 bps, hard-capped at MAX_SLIPPAGE_BPS. */
  slippageBps?: number;
  /** Optional integrator rebate tag. */
  referralCode?: string;
  /** Selects the 1 bp stable vs 5 bp partner volume fee. */
  isStablePair?: boolean;
  /**
   * Optional allowance reader. When provided, the builder prepends an approve
   * only if the Safe's allowance for the Ophis relayer is below the pull amount.
   * When omitted, it approves defensively (reset-to-0 then exact approve).
   */
  readAllowance?: (token: Address, owner: Address, spender: Address) => Promise<bigint>;
}

export interface OphisSafePresignResult {
  orderUid: string;
  txs: TxCall[];
  settlement: Address;
  relayer: Address;
}

export async function buildOphisSafePresign(p: OphisSafePresignParams): Promise<OphisSafePresignResult> {
  assertErc20(p.sellToken, 'Sell token');
  assertErc20(p.buyToken, 'Buy token');
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  assertSlippageBps(slippageBps);

  const requestedSellToken = getAddress(p.sellToken);
  const requestedBuyToken = getAddress(p.buyToken);
  const requestedGross = BigInt(p.sellAmount);
  if (requestedGross <= 0n) throw new Error(`sellAmount must be > 0 (atomic units); got ${p.sellAmount}`);

  // Fee-bearing appData; the Safe is the EIP-1271 contract signer (metadata.signer).
  const appDataInput = buildOphisOrderMetadata({
    chainId: p.chainId,
    referralCode: p.referralCode,
    isStablePair: p.isStablePair,
    signer: p.safe,
  });
  const doc = await new MetadataApi().generateAppDataDoc(appDataInput as never);
  const fullAppData = await stringifyDeterministic(doc as never);
  const appDataHash = keccak256(toBytes(fullAppData));

  // Quote against the OPHIS orderbook host (hitting api.cow.fi directly drops the fee).
  const api = new OrderBookApi({ chainId: p.chainId, baseUrls: { [p.chainId]: getOphisOrderbookUrl(p.chainId) } } as never);
  const receiver = ophisOrderReceiver(p.safe);
  const quoteRes = (await api.getQuote({
    kind: OrderQuoteSideKindSell.SELL,
    sellToken: requestedSellToken,
    buyToken: requestedBuyToken,
    sellAmountBeforeFee: requestedGross.toString(),
    from: p.safe,
    receiver,
    appData: appDataHash,
    appDataHash,
    signingScheme: SigningScheme.PRESIGN,
  } as never)) as { quote?: Record<string, unknown> } & Record<string, unknown>;
  const q = (quoteRes.quote ?? quoteRes) as Record<string, unknown>;

  const order = assembleVaultOrder({
    safe: p.safe,
    quoteSellToken: String(q.sellToken),
    quoteBuyToken: String(q.buyToken),
    quoteSellAmount: String(q.sellAmount),
    quoteFeeAmount: String(q.feeAmount),
    quoteBuyAmount: String(q.buyAmount),
    requestedSellToken,
    requestedBuyToken,
    requestedGross,
    appDataHash,
    slippageBps,
    ttlSeconds: ORDER_TTL_SECONDS,
    nowSeconds: Math.floor(Date.now() / 1000),
    minBuyAmount: p.minBuyAmount !== undefined ? BigInt(p.minBuyAmount) : undefined,
  });

  // Create the order PRESIGNATURE_PENDING; for presign the signature is the Safe address.
  const body = buildOphisOrderCreation({
    order,
    owner: p.safe,
    fullAppData,
    appDataHash,
    signature: p.safe,
    signingScheme: 'presign',
  } as never);
  const hostUid = (await api.sendOrder(body as never)) as unknown as string;
  // CRITICAL: never trust the host's uid. Re-derive it from the locally guarded
  // order and refuse to presign anything else (a compromised host could return a
  // different order's uid to redirect the drain).
  const orderUid = assertUidMatches(hostUid, order, p.chainId, p.safe);

  // Build the [approve?, setPreSignature] batch. pullAmount = the gross settlement pulls.
  const pullAmount = BigInt(order.sellAmount);
  let currentAllowance: bigint | null = null;
  if (p.readAllowance) {
    try {
      currentAllowance = await p.readAllowance(order.sellToken, p.safe, getOphisVaultRelayer(p.chainId) as Address);
    } catch {
      currentAllowance = null; // unknown -> approve defensively
    }
  }
  const { txs, settlement, relayer } = buildPresignTxBatch({
    chainId: p.chainId,
    orderUid,
    sellToken: order.sellToken,
    pullAmount,
    currentAllowance,
  });

  return { orderUid, txs, settlement, relayer };
}
