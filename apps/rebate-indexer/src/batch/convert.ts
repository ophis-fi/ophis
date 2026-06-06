import { encodeFunctionData, parseAbi, createPublicClient, http } from 'viem';
import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import {
  OPHIS_SAFE_ADDRESS,
  multiSendCallOnlyAddress,
  WETH_BY_CHAIN,
  GPV2_SETTLEMENT,
  GPV2_VAULT_RELAYER,
} from '../safe/addresses.js';
import { encodeMultiSend, encodeMultiSendCalldata, type InnerCall } from './multisend.js';
import { getSellQuote, placePresignOrder, getOpenOrders } from '../cow/client.js';
import { getNonWethTokenBalances } from '../safe/balances.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'convert' });

const ERC20_APPROVE = parseAbi(['function approve(address spender, uint256 amount)']);
const ERC20_ALLOWANCE = parseAbi(['function allowance(address owner, address spender) view returns (uint256)']);
const SETTLEMENT_PRESIGN = parseAbi(['function setPreSignature(bytes orderUid, bool signed)']);

// Default 2% slippage floor on the conversion buy amount. Fee tokens aren't
// time-sensitive, so a generous floor maximizes fill probability; the quote is
// the reference and we accept down to (100 - bps/100)% of it.
const DEFAULT_SLIPPAGE_BPS = 200;
// Pre-signed orders must survive human Safe signing + execution + a solver fill;
// 7 days is comfortably longer than any monthly cycle's signing window.
const VALID_TO_SECONDS = 7 * 24 * 60 * 60;

export interface ConvertDeps {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  readonly nowSeconds: number;
  readonly slippageBps?: number;
}

export interface ConvertResult {
  readonly proposed: boolean;
  readonly orderCount: number;   // pre-signed sell orders queued (allowance was sufficient)
  readonly approveCount: number; // VaultRelayer approvals queued (order placed next cycle)
  readonly skipped: number;
  readonly safeTxHash: `0x${string}` | null;
}

/** Apply a slippage floor (bps) to a quoted buy amount. Pure; unit-tested. */
export function applySlippageFloor(buyAmount: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range [0,10000): ${slippageBps}`);
  }
  return (buyAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * #360 Option A — convert the fee Safe's non-WETH token balances to WETH via CoW,
 * so the (WETH-only) rebate pool reflects fees that accrue in trade tokens. Per
 * non-WETH balance: (1) skip if the Safe already has a live (open or
 * presignaturePending) sell order for it (idempotency); (2) check the on-chain
 * VaultRelayer allowance — CoW validates it at order SUBMISSION, so if it doesn't
 * yet cover the balance, queue ONLY an `approve(VaultRelayer, balance)` this cycle
 * and place the order next cycle (self-bootstrapping 2-phase); (3) otherwise quote
 * token→WETH (receiver=Safe), POST a pre-signed sell order (buyAmount floored by
 * slippage), and queue `setPreSignature(uid, true)`. Then propose ONE Safe
 * multisend at a distinct nonce. Owners sign + execute; solvers fill; the WETH
 * lands in the Safe and rebates the NEXT cycle.
 *
 * Fail-safe: a per-token failure is logged + skipped (others proceed); if nothing
 * was queued, nothing is proposed. The caller also wraps this in try/catch so it
 * can never break the monthly payout. Gated by the batcher behind
 * REBATE_CONVERT_ENABLED + proposeEnabled.
 */
export async function convertFeesToWeth(deps: ConvertDeps): Promise<ConvertResult> {
  const none: ConvertResult = { proposed: false, orderCount: 0, approveCount: 0, skipped: 0, safeTxHash: null };
  const weth = WETH_BY_CHAIN[deps.chainId];
  if (!weth) {
    log.warn({ chainId: deps.chainId }, 'no WETH configured; skipping conversion');
    return none;
  }
  const slippageBps = deps.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const balances = await getNonWethTokenBalances({ chainId: deps.chainId, safe: OPHIS_SAFE_ADDRESS, weth });
  if (balances.length === 0) return none;

  // Idempotency: tokens that already have a LIVE (open or presignaturePending)
  // sell order from the Safe — don't re-queue them while one is pending.
  let openSellTokens = new Set<string>();
  try {
    const open = await getOpenOrders(deps.chainId, OPHIS_SAFE_ADDRESS);
    openSellTokens = new Set(open.map((o) => o.sellToken.toLowerCase()));
  } catch (err) {
    log.warn({ err }, 'could not list open orders; proceeding without idempotency filter');
  }

  const publicClient = createPublicClient({ transport: http(deps.rpcUrl) });
  const inner: InnerCall[] = [];
  let skipped = 0;
  let orderCount = 0;
  let approveCount = 0;
  const validTo = deps.nowSeconds + VALID_TO_SECONDS;
  for (const bal of balances) {
    const token = bal.tokenAddress.toLowerCase() as `0x${string}`;
    if (openSellTokens.has(token)) { skipped++; continue; }
    let sellAmount: bigint;
    try { sellAmount = BigInt(bal.balance); } catch { log.warn({ bal }, 'unparseable balance; skip'); skipped++; continue; }
    if (sellAmount <= 0n) { skipped++; continue; }
    try {
      // CoW /orders validates the VaultRelayer allowance at SUBMISSION (#474), so a
      // token whose allowance doesn't yet cover its balance gets an approve THIS
      // cycle and the order NEXT cycle (self-bootstrapping 2-phase).
      const allowance = (await publicClient.readContract({
        address: token,
        abi: ERC20_ALLOWANCE,
        functionName: 'allowance',
        args: [OPHIS_SAFE_ADDRESS, GPV2_VAULT_RELAYER],
      })) as bigint;
      if (allowance < sellAmount) {
        inner.push({
          to: token,
          value: 0n,
          data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: 'approve', args: [GPV2_VAULT_RELAYER, sellAmount] }),
        });
        approveCount++;
        log.info({ token, sellAmount: sellAmount.toString() }, 'queued VaultRelayer approval (order placed next cycle)');
        continue;
      }
      // Allowance already covers the balance → place the order now + presign.
      const quote = await getSellQuote({
        chainId: deps.chainId,
        sellToken: token,
        buyToken: weth,
        sellAmountBeforeFee: sellAmount,
        from: OPHIS_SAFE_ADDRESS,
        receiver: OPHIS_SAFE_ADDRESS,
      });
      const minBuy = applySlippageFloor(BigInt(quote.quote.buyAmount), slippageBps);
      if (minBuy <= 0n) { log.warn({ token }, 'quote buyAmount floors to 0; skip'); skipped++; continue; }
      const uid = await placePresignOrder({
        chainId: deps.chainId,
        quote: quote.quote,
        buyAmount: minBuy,
        receiver: OPHIS_SAFE_ADDRESS,
        validTo,
        from: OPHIS_SAFE_ADDRESS,
      });
      inner.push({
        to: GPV2_SETTLEMENT,
        value: 0n,
        data: encodeFunctionData({ abi: SETTLEMENT_PRESIGN, functionName: 'setPreSignature', args: [uid, true] }),
      });
      orderCount++;
      log.info({ token, uid, minBuy: minBuy.toString() }, 'queued conversion order (allowance ok)');
    } catch (err) {
      log.warn({ err, token }, 'conversion step failed for token; skipping it');
      skipped++;
    }
  }

  if (inner.length === 0) return { ...none, skipped };

  const calldata = encodeMultiSendCalldata(encodeMultiSend(inner));
  const multiSend = multiSendCallOnlyAddress(deps.chainId);
  const protocolKit = await Safe.init({
    provider: deps.rpcUrl,
    signer: deps.proposerPrivateKey,
    safeAddress: OPHIS_SAFE_ADDRESS,
  });
  const proposerAddress = (await protocolKit.getSafeProvider().getSignerAddress()) as `0x${string}`;
  const apiKit = new SafeApiKit({ chainId: BigInt(deps.chainId) });
  // Distinct nonce: getNextNonce counts already-queued Tx-Service txs, so this
  // conversion proposal doesn't collide with a same-run monthly payout proposal
  // (Safe txs at the same nonce are mutually exclusive). (Codex #474)
  const nonce = Number(await apiKit.getNextNonce(OPHIS_SAFE_ADDRESS));
  const safeTx = await protocolKit.createTransaction({
    transactions: [{ to: multiSend, value: '0', data: calldata, operation: 1 /* DELEGATECALL */ }],
    options: { nonce },
  });
  const safeTxHash = (await protocolKit.getTransactionHash(safeTx)) as `0x${string}`;
  const sig = await protocolKit.signHash(safeTxHash);
  await apiKit.proposeTransaction({
    safeAddress: OPHIS_SAFE_ADDRESS,
    safeTransactionData: safeTx.data,
    safeTxHash,
    senderAddress: proposerAddress,
    senderSignature: sig.data,
  });
  log.info({ safeTxHash, orderCount, approveCount, skipped, nonce }, 'proposed fee-conversion Safe tx');
  return { proposed: true, orderCount, approveCount, skipped, safeTxHash };
}
