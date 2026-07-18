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
// NOTE: @cowprotocol/cow-sdk and @cowprotocol/app-data are imported LAZILY inside
// buildOphisSafePresign (dynamic import), never at module top. cow-sdk transitively
// initializes @cowprotocol/contracts, whose module init assumes an ethers-v5 API and
// crashes under plain node/vitest with ethers 6 resolved — and this package's main
// consumers are headless node bots. Keeping the barrel pure at init means importing
// @ophis/safe-swap never loads cow-sdk until a quote is actually requested.
import { getAddress, keccak256, toBytes } from 'viem';
import {
  buildOphisOrderCreation,
  buildOphisOrderMetadata,
  enrollOphisTrader,
  getOphisOrderbookUrl,
  getOphisVaultRelayer,
  ophisOrderReceiver,
} from '@ophis/sdk';
import { assertErc20, assertSlippageBps, DEFAULT_SLIPPAGE_BPS } from './guards.js';
import { assembleVaultOrder, assertUidMatches, buildPresignTxBatch, ORDER_TTL_SECONDS, type TxCall, type VaultOrder } from './order.js';

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
  /**
   * Default false: a pre-existing oversized relayer allowance is clamped to exact
   * (least-privilege). Set true ONLY when the Safe deliberately keeps ONE shared
   * relayer allowance funding several CONCURRENT presigned orders, where the clamp
   * would shrink the allowance the other in-flight orders still need (see
   * buildPresignTxBatch). For a normal sequential rebalance, leave it false.
   */
  keepSufficientAllowance?: boolean;
}

export interface OphisSafePresignResult {
  orderUid: string;
  /**
   * The assembled, receiver-pinned order whose uid was posted. A Phase-B
   * policy-module caller passes this to `module.rebalance`, which re-derives and
   * presigns the identical uid; the direct-presign path uses `txs` instead.
   */
  order: VaultOrder;
  /** The full appData preimage (JSON) whose keccak is the order's appDataHash. */
  fullAppData: string;
  txs: TxCall[];
  settlement: Address;
  relayer: Address;
  /**
   * Set when rebate-indexer enrollment failed. The order still built and can
   * settle; the referral rebate may just not index until the Safe is enrolled
   * (enrollment is not a settlement precondition).
   */
  enrollmentWarning?: string;
}

export async function buildOphisSafePresign(p: OphisSafePresignParams): Promise<OphisSafePresignResult> {
  assertErc20(p.sellToken, 'Sell token');
  assertErc20(p.buyToken, 'Buy token');
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  assertSlippageBps(slippageBps);

  // A caller hard min-out must be a positive atomic amount. A negative/zero value
  // (a defaulting/config bug) would make assertBuyFloor accept any positive signed
  // floor, silently disabling the min-out protection.
  let minBuyAmount: bigint | undefined;
  if (p.minBuyAmount !== undefined) {
    minBuyAmount = BigInt(p.minBuyAmount);
    if (minBuyAmount <= 0n) throw new Error(`minBuyAmount must be > 0 (atomic units); got ${p.minBuyAmount}`);
  }

  // as Address: an optional adapter (exec-safe) brings protocol-kit's bundled viem
  // into the type program; pin getAddress's checksummed result to the local alias.
  const requestedSellToken = getAddress(p.sellToken) as Address;
  const requestedBuyToken = getAddress(p.buyToken) as Address;
  const requestedGross = BigInt(p.sellAmount);
  if (requestedGross <= 0n) throw new Error(`sellAmount must be > 0 (atomic units); got ${p.sellAmount}`);

  // Lazy-load the CoW SDKs here (see the module-top note): the wire enum values are
  // the plain strings 'sell' / 'presign', so no static enum import is needed.
  const [{ OrderBookApi }, { MetadataApi, stringifyDeterministic }] = await Promise.all([
    import('@cowprotocol/cow-sdk'),
    import('@cowprotocol/app-data'),
  ]);

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
    kind: 'sell',
    sellToken: requestedSellToken,
    buyToken: requestedBuyToken,
    sellAmountBeforeFee: requestedGross.toString(),
    from: p.safe,
    receiver,
    // Quote WITH the full appData PREIMAGE (partner fee + referrer). The Ophis
    // orderbook DTO treats appData+appDataHash as {full, expected} and validates
    // keccak(full) == expected, so passing the bytes32 hash as appData fails
    // app-data validation (and would price a no-fee order). Pass the preimage,
    // exactly as the safe-app quote path does.
    appData: fullAppData,
    appDataHash,
    signingScheme: 'presign',
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
    minBuyAmount,
  });

  // Enroll the Safe with the rebate indexer BEFORE creating the order: the indexer
  // is owner-scoped, so an unenrolled Safe settles fine but its referral rebate is
  // NEVER indexed (the existing Safe/EOA paths enroll first). Non-blocking, because
  // enrollment is not a settlement precondition: a failure surfaces a warning.
  let enrollmentWarning: string | undefined;
  try {
    await enrollOphisTrader(p.safe);
  } catch (e) {
    enrollmentWarning = (e as Error).message;
  }

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
    keepSufficientAllowance: p.keepSufficientAllowance,
  });

  // `order` + `fullAppData` are returned so a Phase-B policy-module caller can
  // pass the exact posted order to `module.rebalance` (the module re-derives and
  // presigns the same uid); the direct-presign path uses `txs`.
  return { orderUid, order, fullAppData, txs, settlement, relayer, enrollmentWarning };
}
