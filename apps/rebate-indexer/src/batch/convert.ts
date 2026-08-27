import { encodeFunctionData, decodeFunctionData, parseAbi, createPublicClient, http } from 'viem';
import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import {
  OPHIS_SAFE_ADDRESS,
  multiSendCallOnlyAddress,
  WETH_BY_CHAIN,
  WRAPPED_NATIVE_BY_CHAIN,
  safeTxServiceUrl,
  GPV2_SETTLEMENT,
  GPV2_VAULT_RELAYER,
} from '../safe/addresses.js';
import { encodeMultiSend, encodeMultiSendCalldata, decodeMultiSendCalldata, type InnerCall } from './multisend.js';
import { getSellQuote, placePresignOrder, getOpenOrders } from '../cow/client.js';
import { getNonWethTokenBalances } from '../safe/balances.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'convert' });

const ERC20_APPROVE = parseAbi(['function approve(address spender, uint256 amount)']);
const ERC20_ALLOWANCE = parseAbi(['function allowance(address owner, address spender) view returns (uint256)']);
const SETTLEMENT_PRESIGN = parseAbi(['function setPreSignature(bytes orderUid, bool signed)']);
const WRAPPED_NATIVE_DEPOSIT = parseAbi(['function deposit() payable']);

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
  /**
   * Abort signal from the caller's overall-step timeout. Threaded into the CoW HTTP
   * calls AND checked immediately before the Safe proposal, so a timed-out conversion
   * cannot keep running and queue a Safe tx after the batcher moved on. (#360 abort,
   * Codex #474)
   */
  readonly signal?: AbortSignal;
  /**
   * Explicit Safe nonce for the conversion proposal. The batcher passes the payout's
   * nonce + 1 so the conversion is DETERMINISTICALLY above the payout — independent of
   * whether the Safe Tx Service has yet reflected the just-posted payout (a getNextNonce
   * read could otherwise race and hand the conversion the SAME nonce as the payout,
   * which would invalidate it). Falls back to getNextNonce only if unset. (Codex #474)
   */
  readonly nonce?: number;
  /**
   * Bootstrap mode: this conversion is being proposed with NO payout above it,
   * from the batcher's no-payout path. Only legal when the Safe's pending queue is
   * readable and empty (see canBootstrapPropose) - without that gate this would
   * reintroduce the Codex #474 hazard of an unsigned tx blocking a later payout.
   */
  readonly bootstrap?: boolean;
}

export interface ConvertResult {
  readonly proposed: boolean;
  readonly orderCount: number;   // pre-signed sell orders queued (allowance was sufficient)
  readonly approveCount: number; // VaultRelayer approvals queued (order placed next cycle)
  readonly skipped: number;
  readonly safeTxHash: `0x${string}` | null;
  // Native wei this proposal wraps, 0n when it wraps nothing. Reported because a
  // wrap-only proposal has zero orders and zero approvals, and describing a
  // transaction that moves the Safe's ENTIRE native balance as "0 orders + 0
  // approvals" to the humans deciding whether to sign it is worse than useless.
  readonly nativeWrappedWei: bigint;
}

/**
 * Queue `deposit()` on the chain's native-coin wrapper, forwarding the whole native
 * balance as msg.value. Pure; unit-tested.
 *
 * CoW pays partner fees out of its Solver Rewards Safe in the chain's NATIVE coin,
 * not in the trade's surplus ERC20 that #360 was designed around. Native is not an
 * ERC20, so it is invisible to both the WETH pool read and the token probe, and it
 * accrued untouched (2026-08-27 audit). Wrapping puts it back on the ERC20 rails the
 * rest of this pipeline already understands.
 *
 * Below `minWrapWei` we queue nothing: a wrap costs gas and an owner signature, so
 * dust is left to accumulate until it is worth a transaction.
 *
 * The Safe pays no gas from its own balance (execTransaction is funded by the
 * executing owner), so there is no reserve to hold back — the full balance wraps.
 */
export function buildNativeWrapCall(
  nativeWei: bigint,
  minWrapWei: bigint,
  wrappedNative: `0x${string}`,
): InnerCall[] {
  if (nativeWei <= 0n || nativeWei < minWrapWei) return [];
  return [
    {
      to: wrappedNative,
      value: nativeWei,
      data: encodeFunctionData({ abi: WRAPPED_NATIVE_DEPOSIT, functionName: 'deposit' }),
    },
  ];
}

/**
 * Per-chain native-wrap floor, in wei of that chain's NATIVE coin.
 *
 * Per chain because the coins are not comparable: 1 xDAI is ~$1 while 1 ETH is
 * ~$2,500, so one shared wei threshold is either meaningless on Gnosis or absurd on
 * the OP-stack chains. These land around $1 on Gnosis and around $7 on OP-stack,
 * the same magnitude as the settlement sweep script's WETH threshold.
 */
const MIN_WRAP_NATIVE_WEI_BY_CHAIN: Readonly<Record<number, bigint>> = {
  100: 1_000_000_000_000_000_000n, // 1 xDAI
  10: 3_000_000_000_000_000n, // 0.003 ETH
  130: 3_000_000_000_000_000n, // 0.003 ETH
};

/**
 * Resolve the native wrap for a chain: the wrapper address and floor, or [] when the
 * chain has neither configured. Pure; unit-tested.
 *
 * Degrades to [] rather than throwing on an unconfigured chain — this runs on the
 * payout path, and an unmapped chain must mean "do nothing", never "take the batcher
 * down".
 */
export function buildNativeWrapForChain(chainId: number, nativeWei: bigint): InnerCall[] {
  const wrapped = WRAPPED_NATIVE_BY_CHAIN[chainId];
  const floor = MIN_WRAP_NATIVE_WEI_BY_CHAIN[chainId];
  if (!wrapped || floor === undefined) return [];
  return buildNativeWrapCall(nativeWei, floor, wrapped);
}

/** What the Safe's pending-transaction queue told us, including whether we could read it. */
export interface PendingQueue {
  readonly ok: boolean; // false = the queue could not be read; treat as "unknown", not "empty"
  readonly count: number;
  readonly approvals: Set<string>;
  readonly wraps: Set<string>;
}

/**
 * Whether a native wrap may be queued this cycle. Pure; unit-tested.
 *
 * Fails CLOSED on an unreadable queue. A wrap forwards the Safe's entire native
 * balance, so a duplicate does not merely waste gas: once the first executes, the
 * second reverts for insufficient balance and takes every other inner call in its
 * multisend down with it. "We could not check" must therefore behave like "one is
 * already pending", not like "none is pending".
 */
export function shouldQueueWrap(wrapCalls: readonly InnerCall[], pending: PendingQueue): boolean {
  if (wrapCalls.length === 0) return false;
  if (!pending.ok) return false;
  return !pending.wraps.has(wrapCalls[0]!.to.toLowerCase());
}

/**
 * Whether a BOOTSTRAP conversion (one proposed with no payout above it) may be
 * proposed. Pure; unit-tested.
 *
 * Codex #474 established that a standalone conversion occupies a nonce with no
 * payout above it and can block the next cycle's payout if it is left unsigned,
 * which is why conversions normally run only after a successful payout. On Gnosis
 * that rule deadlocks the system: the pool reads WETH, the fees arrive as native
 * xDAI, so the pool is 0, so there is no payout, so no conversion ever runs, so the
 * pool stays 0 - forever. Nothing converts the fees because nothing was converted.
 *
 * The bootstrap breaks the cycle under the narrowest condition that keeps #474's
 * guarantee intact: propose ONLY when the queue was readable and completely empty.
 * The conversion then takes the immediate next nonce with nothing queued behind it,
 * and the payout it could theoretically block is one that cannot exist until this
 * very conversion succeeds.
 */
export function canBootstrapPropose(pending: PendingQueue): boolean {
  return pending.ok && pending.count === 0;
}

/** Apply a slippage floor (bps) to a quoted buy amount. Pure; unit-tested. */
export function applySlippageFloor(buyAmount: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range [0,10000): ${slippageBps}`);
  }
  return (buyAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Build the VaultRelayer approval inner-call(s) for one token, given its CURRENT
 * on-chain allowance and the amount to sell. Pure; unit-tested. (#360, Codex #474)
 * - allowance already covers the sell amount → no approval needed (`[]`);
 * - zero allowance → a single `approve(VaultRelayer, sellAmount)`;
 * - a NON-ZERO partial allowance → `approve(VaultRelayer, 0)` THEN
 *   `approve(VaultRelayer, sellAmount)`: USDT-style tokens REVERT on a non-zero →
 *   non-zero `approve`, so the stale allowance must be reset to 0 first.
 */
export function buildVaultRelayerApprovalCalls(
  allowance: bigint,
  sellAmount: bigint,
  token: `0x${string}`,
): InnerCall[] {
  if (allowance >= sellAmount) return [];
  const approve = (amount: bigint): InnerCall => ({
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: 'approve', args: [GPV2_VAULT_RELAYER, amount] }),
  });
  return allowance > 0n ? [approve(0n), approve(sellAmount)] : [approve(sellAmount)];
}

/**
 * The token addresses (lowercased, de-duplicated) that the given inner calls approve
 * to the GPv2 VaultRelayer. Pure; unit-tested. Used to detect an already-pending
 * VaultRelayer approval in the Safe queue so the conversion doesn't re-queue a
 * duplicate while a prior approval awaits signatures — the approval bootstrap places
 * no CoW order, so getOpenOrders alone can't see it (#360 idempotency, Codex #474).
 */
/**
 * The wrapper addresses (lowercased, de-duplicated) that the given inner calls send a
 * native-coin `deposit()` to. Pure; unit-tested.
 *
 * Same idempotency need the VaultRelayer approvals have (Codex #474), and sharper
 * here: a wrap forwards the Safe's WHOLE native balance as msg.value. Queue a second
 * one while the first sits unsigned and, once the first executes, the second reverts
 * on insufficient balance — taking every other inner call in that multisend down with
 * it. Detecting a pending wrap is what keeps that batch from being poisoned.
 */
export function nativeWrapTargets(calls: readonly InnerCall[]): string[] {
  const targets = new Set<string>();
  for (const call of calls) {
    try {
      if (decodeFunctionData({ abi: WRAPPED_NATIVE_DEPOSIT, data: call.data }).functionName === 'deposit') {
        targets.add(call.to.toLowerCase());
      }
    } catch {
      // not a deposit() / undecodable inner call — ignore
    }
  }
  return [...targets];
}

export function vaultRelayerApprovalTokens(calls: readonly InnerCall[]): string[] {
  const vr = GPV2_VAULT_RELAYER.toLowerCase();
  const tokens = new Set<string>();
  for (const call of calls) {
    try {
      const decoded = decodeFunctionData({ abi: ERC20_APPROVE, data: call.data });
      if (decoded.functionName === 'approve' && (decoded.args[0] as string).toLowerCase() === vr) {
        tokens.add(call.to.toLowerCase());
      }
    } catch {
      // not an approve / undecodable inner call — ignore
    }
  }
  return [...tokens];
}

/**
 * Tokens that ALREADY have a pending (queued, unexecuted) VaultRelayer approval in
 * the Safe queue. The approval bootstrap places no CoW order, so getOpenOrders can't
 * see it; without this, a re-run before the prior approval executes would re-queue a
 * duplicate approval (#360 idempotency, Codex #474). Decodes each pending multisend
 * tx and collects its approve→VaultRelayer tokens. NEVER throws — a Tx-Service read
 * failure just disables this layer (the per-token on-chain allowance check still
 * caps the worst case at one redundant approve).
 */
async function pendingApprovalTokens(apiKit: SafeApiKit, safe: `0x${string}`): Promise<PendingQueue> {
  const approvals = new Set<string>();
  const wraps = new Set<string>();
  try {
    const pending = await apiKit.getPendingTransactions(safe);
    const results = pending.results ?? [];
    for (const tx of results) {
      if (!tx.data) continue;
      // Inner calls of a MultiSend...
      const calls = decodeMultiSendCalldata(tx.data as `0x${string}`);
      for (const t of vaultRelayerApprovalTokens(calls)) approvals.add(t);
      for (const t of nativeWrapTargets(calls)) wraps.add(t);
      // ...AND the transaction's own top-level call. An owner can queue a direct
      // `WXDAI.deposit()` by hand rather than through a MultiSend; decoding that as
      // multiSend(bytes) yields no inner calls, so the wrapper would be missing from
      // `wraps` and we would queue a second full-balance wrap behind it.
      const top: InnerCall = {
        to: tx.to as `0x${string}`,
        value: BigInt(tx.value ?? 0),
        data: tx.data as `0x${string}`,
      };
      for (const t of vaultRelayerApprovalTokens([top])) approvals.add(t);
      for (const t of nativeWrapTargets([top])) wraps.add(t);
    }
    return { ok: true, count: results.length, approvals, wraps };
  } catch (err) {
    // `ok: false` is load-bearing, not cosmetic. The approval path can safely
    // degrade to a redundant approve, but the WRAP path cannot: a wrap forwards
    // the Safe's entire native balance, so proposing a second one because we
    // could not see the first reverts the whole multisend once the first
    // executes. An unreadable queue therefore means "do not wrap", never
    // "nothing is pending".
    log.warn({ err }, 'could not list pending Safe txs; approval idempotency degraded and native wrapping suppressed');
    return { ok: false, count: 0, approvals, wraps };
  }
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
  const none: ConvertResult = { proposed: false, orderCount: 0, approveCount: 0, skipped: 0, safeTxHash: null, nativeWrappedWei: 0n };
  const weth = WETH_BY_CHAIN[deps.chainId];
  if (!weth) {
    log.warn({ chainId: deps.chainId }, 'no WETH configured; skipping conversion');
    return none;
  }
  const slippageBps = deps.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const balances = await getNonWethTokenBalances({ chainId: deps.chainId, safe: OPHIS_SAFE_ADDRESS, weth });

  // Native coin: read on-chain, NOT from the Safe API token rows (which report it as
  // a `tokenAddress: null` row getNonWethTokenBalances drops). This is the asset CoW
  // actually pays partner fees in, so it must be able to drive a cycle on its own —
  // the old `balances.length === 0` early return is exactly what left a native-only
  // Safe untouched (2026-08-27 audit: the Gnosis Safe held 100% of realized revenue
  // and this function returned immediately, every cycle).
  // Isolated try/catch: this read is ADDITIVE to the pre-existing ERC20 path. If it
  // escaped, a transient native-balance RPC hiccup would abort the whole conversion
  // and regress #360 for tokens that were read successfully. Degrade to 0n (no wrap
  // this cycle) rather than losing the ERC20 leg.
  let nativeWei = 0n;
  try {
    nativeWei = await createPublicClient({ transport: http(deps.rpcUrl) }).getBalance({
      address: OPHIS_SAFE_ADDRESS,
    });
  } catch (err) {
    log.warn({ err }, 'native balance read failed; skipping the wrap this cycle (ERC20 conversion proceeds)');
  }
  const wrapCalls = buildNativeWrapForChain(deps.chainId, nativeWei);
  if (balances.length === 0 && wrapCalls.length === 0) return none;

  // api-kit v2.5 has no built-in Unichain (130) entry and THROWS without an explicit
  // txServiceUrl, which would have made every chain-130 conversion fail as soon as
  // this file started handling 130. propose.ts and poll.ts already do this.
  const txServiceUrl = safeTxServiceUrl(deps.chainId);
  const apiKit = new SafeApiKit({ chainId: BigInt(deps.chainId), ...(txServiceUrl ? { txServiceUrl } : {}) });

  // Idempotency — skip any token already being handled, from EITHER source:
  //  (a) a LIVE CoW sell order (open / presignaturePending) from a prior cycle; or
  //  (b) a still-pending VaultRelayer approval in the Safe queue — the approve
  //      bootstrap places no CoW order, so (a) alone can't see it (Codex #474).
  // A read failure on either source only drops THAT layer; the per-token on-chain
  // allowance check below still bounds the worst case to one redundant approve.
  const handled = new Set<string>();
  try {
    const open = await getOpenOrders(deps.chainId, OPHIS_SAFE_ADDRESS, deps.signal);
    for (const o of open) handled.add(o.sellToken.toLowerCase());
  } catch (err) {
    log.warn({ err }, 'could not list open orders; proceeding without the open-order idempotency filter');
  }
  const pending = await pendingApprovalTokens(apiKit, OPHIS_SAFE_ADDRESS);
  for (const t of pending.approvals) handled.add(t);

  // A bootstrap proposal has no payout above it, so it may only go out when the
  // queue is readable AND empty. Bail before doing any CoW work we would discard.
  if (deps.bootstrap && !canBootstrapPropose(pending)) {
    log.info(
      { chainId: deps.chainId, queueOk: pending.ok, queueCount: pending.count },
      'bootstrap conversion skipped: the Safe queue is non-empty or unreadable',
    );
    return none;
  }

  const publicClient = createPublicClient({ transport: http(deps.rpcUrl) });
  const queuedWraps = shouldQueueWrap(wrapCalls, pending) ? wrapCalls : [];
  const wrapPending = wrapCalls.length > 0 && queuedWraps.length === 0;
  // Wrap FIRST. It has no dependency on anything below it, and putting it at the head
  // means a batch that is otherwise all approvals still leads with the call that moves
  // real value. The wrapped balance is picked up as an ordinary non-WETH ERC20 next
  // cycle: on Gnosis it then needs the WXDAI -> WETH leg, on the OP-stack chains the
  // wrapper already IS the pool token and the pool sees it immediately.
  const inner: InnerCall[] = [...queuedWraps];
  if (wrapPending) {
    log.info(
      { chainId: deps.chainId, wrapper: wrapCalls[0]!.to, queueOk: pending.ok },
      pending.ok
        ? 'native wrap already pending in the Safe queue; not re-queuing'
        : 'Safe queue unreadable; suppressing the native wrap rather than risking a duplicate',
    );
  } else if (queuedWraps.length > 0) {
    log.info(
      { chainId: deps.chainId, nativeWei: nativeWei.toString(), wrapped: queuedWraps[0]!.to },
      'queued native-coin wrap (CoW pays partner fees in the native coin)',
    );
  }
  let skipped = 0;
  let orderCount = 0;
  let approveCount = 0;
  const validTo = deps.nowSeconds + VALID_TO_SECONDS;
  for (const bal of balances) {
    // Overall-step timeout fired mid-loop → stop queuing more; the pre-propose guard
    // below ensures nothing already queued gets proposed late. (#360 abort)
    if (deps.signal?.aborted) break;
    const token = bal.tokenAddress.toLowerCase() as `0x${string}`;
    if (handled.has(token)) { skipped++; continue; }
    let sellAmount: bigint;
    try { sellAmount = BigInt(bal.balance); } catch { log.warn({ bal }, 'unparseable balance; skip'); skipped++; continue; }
    if (sellAmount <= 0n) { skipped++; continue; }
    try {
      // CoW /orders validates the VaultRelayer allowance at SUBMISSION (#474), so a
      // token whose allowance doesn't yet cover its balance gets an approve THIS
      // cycle and the order NEXT cycle (self-bootstrapping 2-phase). A non-zero
      // partial allowance is reset to 0 first for USDT-style tokens (Codex #474).
      const allowance = (await publicClient.readContract({
        address: token,
        abi: ERC20_ALLOWANCE,
        functionName: 'allowance',
        args: [OPHIS_SAFE_ADDRESS, GPV2_VAULT_RELAYER],
      })) as bigint;
      const approvals = buildVaultRelayerApprovalCalls(allowance, sellAmount, token);
      if (approvals.length > 0) {
        inner.push(...approvals);
        approveCount++; // one logical approval per token (a USDT reset is 2 inner calls)
        log.info(
          { token, sellAmount: sellAmount.toString(), reset: approvals.length > 1 },
          'queued VaultRelayer approval (order placed next cycle)',
        );
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
        signal: deps.signal,
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
        signal: deps.signal,
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

  // Pre-propose abort guard: if the overall-step timeout fired mid-conversion, do
  // NOT queue a Safe tx — the batcher has already moved on, and a late/duplicate
  // proposal is a money-path hazard. Any orders already POSTed sit presignaturePending
  // and are caught by the open-order idempotency filter next cycle. (#360, Codex #474)
  if (deps.signal?.aborted) {
    log.warn({ orderCount, approveCount, skipped }, 'fee conversion aborted before propose; not queuing a Safe tx (#360)');
    return { ...none, skipped };
  }

  const calldata = encodeMultiSendCalldata(encodeMultiSend(inner));
  const multiSend = multiSendCallOnlyAddress(deps.chainId);
  const protocolKit = await Safe.init({
    provider: deps.rpcUrl,
    signer: deps.proposerPrivateKey,
    safeAddress: OPHIS_SAFE_ADDRESS,
  });
  const proposerAddress = (await protocolKit.getSafeProvider().getSignerAddress()) as `0x${string}`;
  // Nonce: the batcher pins this to the payout's nonce + 1 (deps.nonce) so the
  // conversion is DETERMINISTICALLY above the payout even if the Safe Tx Service has
  // not yet reflected the just-posted payout — a getNextNonce read could otherwise
  // race and return the SAME nonce as the payout, and executing the conversion would
  // then invalidate the payout. Falls back to getNextNonce only when unpinned. (Codex #474)
  const nonce = deps.nonce ?? Number(await apiKit.getNextNonce(OPHIS_SAFE_ADDRESS));
  const safeTx = await protocolKit.createTransaction({
    transactions: [{ to: multiSend, value: '0', data: calldata, operation: 1 /* DELEGATECALL */ }],
    options: { nonce },
  });
  const safeTxHash = (await protocolKit.getTransactionHash(safeTx)) as `0x${string}`;
  const sig = await protocolKit.signHash(safeTxHash);
  // Re-check directly before the POST: the Safe-SDK calls above (init / getNextNonce
  // / sign) do NOT honor the abort signal, so the timeout could have fired during
  // them. This closes the last window before the irreversible queue write. (Codex #474)
  if (deps.signal?.aborted) {
    log.warn({ orderCount, approveCount, skipped }, 'fee conversion aborted before the Safe POST; not queuing (#360)');
    return { ...none, skipped };
  }
  await apiKit.proposeTransaction({
    safeAddress: OPHIS_SAFE_ADDRESS,
    safeTransactionData: safeTx.data,
    safeTxHash,
    senderAddress: proposerAddress,
    senderSignature: sig.data,
  });
  log.info({ safeTxHash, orderCount, approveCount, skipped, nonce }, 'proposed fee-conversion Safe tx');
  return {
    proposed: true,
    orderCount,
    approveCount,
    skipped,
    safeTxHash,
    nativeWrappedWei: queuedWraps.length > 0 ? nativeWei : 0n,
  };
}
