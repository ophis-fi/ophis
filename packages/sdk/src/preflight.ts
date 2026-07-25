/**
 * Multicall3 balance/allowance preflight: answers "can this order actually
 * settle?" BEFORE the user signs. One batched eth_call reads balanceOf +
 * allowance for every check; the caller compares against the required amount
 * (sellAmount + feeAmount) and routes to the approve UX instead of letting
 * the orderbook reject the signed order with a 4xxx balance error.
 *
 * Fail-closed by construction:
 * - a rejected multicall THROWS (OphisPreflightError). It never degrades into
 *   an "everything is ready" result, because a silently skipped check reads
 *   exactly like a passed one.
 * - a batch in which EVERY call failed also THROWS. viem with
 *   allowFailure: true does not reject when the aggregate eth_call itself
 *   fails (network or RPC outage): it returns one failure entry per contract,
 *   which would zero every balance and surface as "insufficient funds" or a
 *   pointless approve prompt. An all-failure batch is indistinguishable from
 *   an outage without trusting error shapes, so it is never answered; per
 *   token zeroing applies only to PARTIAL failures.
 * - the batch is one eth_call snapshot: chunking is disabled (batchSize: 0),
 *   so every balance and allowance in a preflight is read at one block and a
 *   token's two reads can never straddle a state change. (viem allows a
 *   client-level batch.multicall.batchSize to override the per-call value;
 *   even then, a chunk that fails only ever produces failure entries, which
 *   the guards above refuse to answer or zero fail-closed.)
 * - a per-token read failure (weird token, missing method) zeroes that value
 *   and pins its sufficiency to false, so a failed read can never report ready.
 * - when the client exposes getChainId (viem PublicClient does), the connected
 *   chain is verified against the chainId argument and a mismatch THROWS.
 *   Shared deterministic addresses (the canonical vault relayer on 11 chains,
 *   OP-stack WETH at 0x4200...0006) make a wrong-chain read look completely
 *   plausible, so it must never be answered. Clients without getChainId
 *   proceed unchecked; the chainId argument is then trusted.
 *
 * Zero runtime dependencies: OphisMulticallClient is structural, so any viem
 * PublicClient satisfies it as-is, but nothing here imports viem at runtime
 * (viem stays a peerDependency, used only by the order-build module).
 */
import { assertValidChainId, assertAddressLike } from './guards.js';
import { getOphisVaultRelayer } from './domain.js';
import type { Address } from './order-build.js';

/** Multicall3, deployed at the same deterministic address on every chain Ophis serves. */
export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * The two ERC-20 reads the preflight batches. Exported so other surfaces
 * (e.g. the swap app's fresh pre-sign read) reuse the exact same fragment.
 */
export const ERC20_PREFLIGHT_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** One entry of the batched read. Structurally compatible with viem's contracts array. */
export interface OphisMulticallCall {
  readonly address: Address;
  readonly abi: unknown;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

/**
 * The one capability the preflight needs from an RPC client: a batched
 * `multicall`. Structural on purpose: any viem PublicClient satisfies it
 * without a cast and without @ophis/sdk importing viem at runtime. The
 * resolved value is validated at runtime (see OphisPreflightError), so a
 * client that does not honor `allowFailure` semantics fails loudly.
 */
export interface OphisMulticallClient {
  multicall(args: {
    contracts: readonly OphisMulticallCall[];
    allowFailure?: boolean;
    multicallAddress?: Address;
    /** Calldata chunk size limit; 0 disables chunking so the batch stays one eth_call (one block snapshot). */
    batchSize?: number;
  }): Promise<unknown>;
  /**
   * Optional connected-chain probe. When present (viem PublicClient has it),
   * ophisPreflight verifies the connected chain matches its chainId argument
   * and throws OphisPreflightError on mismatch. When absent, the preflight
   * proceeds and trusts the chainId argument.
   */
  getChainId?(): Promise<number>;
}

/** One balance+allowance check request. */
export interface OphisPreflightRequest {
  /** The sell token to read. */
  token: Address;
  /** The order owner (who holds and approved the tokens). */
  owner: Address;
  /** Amount that must be held AND approved: sellAmount + feeAmount, in atoms. Must be a positive bigint. */
  required: bigint;
  /** The approve spender. Defaults to the chain's GPv2VaultRelayer via getOphisVaultRelayer, which is the correct spender for a CoW order (approving the settlement instead is the classic unfillable-order mistake). */
  spender?: Address;
}

/** The answer for one check. `ready` is only true when both reads succeeded and both amounts cover `required`. */
export interface OphisPreflightResult {
  token: Address;
  owner: Address;
  /** The spender actually checked (explicit one, or the chain's vault relayer). */
  spender: Address;
  required: bigint;
  /** On-chain balance; 0n when the read failed (fail-closed). */
  balance: bigint;
  /** On-chain allowance for `spender`; 0n when the read failed (fail-closed). */
  allowance: bigint;
  /** True when the balanceOf call itself failed inside the batch. */
  balanceReadFailed: boolean;
  /** True when the allowance call itself failed inside the batch. */
  allowanceReadFailed: boolean;
  sufficientBalance: boolean;
  sufficientAllowance: boolean;
  /** is_ready semantics: balance and allowance both read successfully and both cover `required`. */
  ready: boolean;
}

/**
 * The batched read could not be performed or returned a shape the SDK cannot
 * trust. Deliberately a throw, never a degraded result: an unreadable chain
 * state must stop the signing flow, not wave it through.
 */
export class OphisPreflightError extends Error {
  override readonly name = 'OphisPreflightError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

interface MulticallEntry {
  status: 'success' | 'failure';
  result?: unknown;
  /** The per-call error viem attaches to failure entries; surfaced when an all-failure batch throws. */
  error?: unknown;
}

const parseEntries = (raw: unknown, expected: number): MulticallEntry[] => {
  if (!Array.isArray(raw) || raw.length !== expected) {
    throw new OphisPreflightError(
      `Ophis: multicall returned ${Array.isArray(raw) ? `${raw.length} results` : 'a non-array'}, expected ${expected}. ` +
        'The client did not honor the batched-read contract; refusing to guess.',
    );
  }
  // Array.from materializes holes as undefined, so a sparse array from a
  // misbehaving client hits the typed diagnostic below instead of a generic
  // property-access error.
  return Array.from(raw as ArrayLike<unknown>, (entry, index) => {
    const status = (entry as { status?: unknown } | null)?.status;
    if (status !== 'success' && status !== 'failure') {
      throw new OphisPreflightError(
        `Ophis: multicall entry ${index} has no allowFailure status. ` +
          'Expected { status: "success" | "failure" } entries (viem multicall with allowFailure: true).',
      );
    }
    return {
      status,
      result: (entry as { result?: unknown }).result,
      error: (entry as { error?: unknown }).error,
    };
  });
};

/**
 * An all-failure batch must throw, never answer. viem with allowFailure: true
 * swallows a rejected aggregate eth_call (network or RPC outage) into one
 * failure entry per contract, bypassing the try/catch around the call, and
 * zeroing everything would show the user "insufficient funds" during an
 * outage. A batch whose every call failed is indistinguishable from that
 * outage without trusting error shapes, so refusing to answer is the
 * fail-closed choice even in the rare universal-revert case. The underlying
 * error names ride along as a diagnostic only; they never gate the decision.
 */
const assertNotTotalFailure = (entries: readonly MulticallEntry[]): void => {
  if (!entries.every((entry) => entry.status === 'failure')) return;
  const errors = entries.map((entry) => entry.error).filter((error) => error !== undefined);
  const names = [...new Set(errors.map((error) => (error instanceof Error ? error.name : typeof error)))];
  throw new OphisPreflightError(
    `Ophis: every call in the preflight batch failed (${entries.length} of ${entries.length}); this is indistinguishable ` +
      'from an RPC outage, so no result is returned (answering would read as zero balances).' +
      (names.length > 0 ? ` Underlying error names (diagnostic only): ${names.join(', ')}.` : ''),
    errors.length > 0 ? { cause: new AggregateError(errors, 'every preflight call failed') } : undefined,
  );
};

/** A successful uint256 read must decode to bigint; anything else is a client contract violation, not a zero. */
const readAmount = (entry: MulticallEntry, what: string): { value: bigint; failed: boolean } => {
  if (entry.status === 'failure') return { value: 0n, failed: true };
  if (typeof entry.result !== 'bigint') {
    throw new OphisPreflightError(
      `Ophis: multicall decoded ${what} to ${typeof entry.result}, expected bigint. Refusing to coerce.`,
    );
  }
  return { value: entry.result, failed: false };
};

/**
 * Batched Multicall3 preflight for one or more orders on a chain. Two reads
 * per check (balanceOf, allowance), all in a single eth_call against the
 * canonical Multicall3 (chunking disabled, so the whole batch is one block
 * snapshot), with per-token failures tolerated (allowFailure) and zeroed
 * fail-closed. A batch in which EVERY call failed throws instead: that shape
 * is what a viem allowFailure batch degrades to during an RPC outage, and
 * answering it would read as zero balances. Note the single-check corollary:
 * one check whose balanceOf AND allowance both fail is an all-failure batch
 * and throws rather than reporting not-ready.
 *
 *   const [check] = await ophisPreflight(publicClient, 10, [
 *     { token: sellToken, owner, required: sellAmount + feeAmount },
 *   ]);
 *   if (!check.ready) {
 *     if (check.sufficientBalance) await approve(check.spender, approvalNeeded(check));
 *     else showInsufficientBalance(check);
 *   }
 *
 * Throws OphisPreflightError when the multicall itself fails or returns an
 * untrustworthy shape, and when a client exposing getChainId turns out to be
 * connected to a different chain than `chainId` (a wrong-chain read decodes
 * cleanly and looks plausible, so it must never be answered); throws
 * TypeError on malformed inputs (including an empty checks array: asking for
 * a preflight of nothing is a caller bug, and answering it would read as
 * "ready").
 */
export async function ophisPreflight(
  client: OphisMulticallClient,
  chainId: number,
  checks: readonly OphisPreflightRequest[],
): Promise<OphisPreflightResult[]> {
  assertValidChainId(chainId);
  if (!client || typeof client.multicall !== 'function') {
    throw new TypeError('Ophis: client must expose a multicall method (any viem PublicClient works).');
  }
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new TypeError('Ophis: checks must be a non-empty array. A preflight of nothing would report ready.');
  }

  const resolved = checks.map((check, index) => {
    assertAddressLike(check.token, `checks[${index}].token`);
    assertAddressLike(check.owner, `checks[${index}].owner`);
    if (typeof check.required !== 'bigint' || check.required <= 0n) {
      throw new TypeError(
        `Ophis: checks[${index}].required must be a positive bigint (sellAmount + feeAmount in atoms), received ${String(check.required)}.`,
      );
    }
    const spender = check.spender ?? getOphisVaultRelayer(chainId);
    assertAddressLike(spender, `checks[${index}].spender`);
    return { ...check, spender };
  });

  // Wrong-chain guard: when the client can report its connected chain, a
  // mismatch with the chainId argument must throw. Shared deterministic
  // addresses (canonical vault relayer on 11 chains, OP-stack WETH at
  // 0x4200...0006) make a wrong-chain read decode cleanly and look plausible,
  // which is exactly a fail-open ready. Clients without getChainId proceed
  // unchecked and the chainId argument is trusted.
  if (typeof client.getChainId === 'function') {
    let connected: unknown;
    try {
      connected = await client.getChainId();
    } catch (cause) {
      throw new OphisPreflightError('Ophis: preflight could not verify the connected chain (getChainId failed).', {
        cause,
      });
    }
    if (connected !== chainId) {
      throw new OphisPreflightError(
        `Ophis: preflight chain mismatch: the client is connected to chain ${String(connected)} but the preflight was asked about chain ${chainId}. ` +
          'Reading another chain would return plausible balances for the wrong network; refusing to proceed.',
      );
    }
  }

  const contracts: OphisMulticallCall[] = resolved.flatMap((check) => [
    { address: check.token, abi: ERC20_PREFLIGHT_ABI, functionName: 'balanceOf', args: [check.owner] },
    { address: check.token, abi: ERC20_PREFLIGHT_ABI, functionName: 'allowance', args: [check.owner, check.spender] },
  ]);

  let raw: unknown;
  try {
    // batchSize: 0 disables viem's calldata chunking (default 1024 bytes), so
    // the whole batch is ONE aggregate eth_call: every balance and allowance
    // comes from the same block, and a token's two reads cannot straddle a
    // state change.
    raw = await client.multicall({ contracts, allowFailure: true, batchSize: 0, multicallAddress: MULTICALL3_ADDRESS });
  } catch (cause) {
    // The silent-skip lesson: an RPC failure must throw, never surface as a
    // result. A preflight that cannot read the chain has not passed.
    throw new OphisPreflightError('Ophis: preflight multicall failed; chain state could not be read.', { cause });
  }

  const entries = parseEntries(raw, contracts.length);
  assertNotTotalFailure(entries);

  return resolved.map((check, index) => {
    const balance = readAmount(entries[index * 2] as MulticallEntry, `balanceOf(${check.token})`);
    const allowance = readAmount(entries[index * 2 + 1] as MulticallEntry, `allowance(${check.token})`);
    // Sufficiency is pinned false on a failed read even though the zeroed
    // value already implies it (required > 0n is enforced above): the pin
    // survives any future loosening of that input guard.
    const sufficientBalance = !balance.failed && balance.value >= check.required;
    const sufficientAllowance = !allowance.failed && allowance.value >= check.required;
    return {
      token: check.token,
      owner: check.owner,
      spender: check.spender,
      required: check.required,
      balance: balance.value,
      allowance: allowance.value,
      balanceReadFailed: balance.failed,
      allowanceReadFailed: allowance.failed,
      sufficientBalance,
      sufficientAllowance,
      ready: sufficientBalance && sufficientAllowance,
    };
  });
}

/**
 * is_ready over one result or a batch: true only when every check is ready.
 * An empty batch is NOT ready (nothing was verified).
 */
export function isPreflightReady(results: OphisPreflightResult | readonly OphisPreflightResult[]): boolean {
  if (Array.isArray(results)) {
    const batch = results as readonly OphisPreflightResult[];
    return batch.length > 0 && batch.every((result) => result.ready);
  }
  return (results as OphisPreflightResult).ready;
}

/**
 * approval_needed semantics: how much additional allowance the spender needs
 * before the order can settle; 0n when the current allowance already covers
 * `required`. When the allowance read failed the full `required` is returned
 * (fail-closed: assume nothing is approved).
 */
export function approvalNeeded(result: OphisPreflightResult): bigint {
  if (result.allowanceReadFailed) return result.required;
  return result.allowance >= result.required ? 0n : result.required - result.allowance;
}
