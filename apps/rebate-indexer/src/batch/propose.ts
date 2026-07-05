import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { OPHIS_SAFE_ADDRESS, multiSendCallOnlyAddress, WETH_BY_CHAIN, safeTxServiceUrl } from '../safe/addresses.js';
import { buildRebateMultisend, type Transfer } from './multisend.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'propose' });

export interface ProposeParams {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  readonly transfers: readonly Transfer[];
  /**
   * Invoked exactly once, AFTER all local/RPC pre-submit work (Safe init, tx
   * build, hash, signing) and IMMEDIATELY BEFORE the Safe Transaction Service
   * submit. This is the point of no return: only from here can a proposal be
   * queued. The batcher uses it to flip the cycle row to 'proposing' precisely at
   * this boundary, so a failure during pre-submit (a transient RPC error, bad
   * local config) leaves the cycle auto-resumable rather than wedged into
   * manual-verification. If it throws, the submit is NOT attempted. (Codex P2)
   */
  readonly onBeforeSubmit?: () => Promise<void>;
  /**
   * Explicit Safe nonce for this proposal. When a single run proposes MULTIPLE Safe txs
   * back-to-back (the own-fee catch-up can propose several back-month batches at once),
   * each must take a DISTINCT nonce: the Safe Tx Service may not yet reflect a just-posted
   * proposal, so a fresh getNextNonce read can race and hand the SAME nonce to the next
   * one, and the two then invalidate each other. The caller pins each subsequent proposal
   * to the prior one's nonce + 1 (the same #360 fee-conversion pattern that pins the
   * conversion to payoutNonce + 1, Codex #474). Falls back to getNextNonce only when unset,
   * so the single-proposal batcher / affiliate callers are unchanged.
   */
  readonly nonce?: number;
}

export interface ProposeResult {
  readonly safeTxHash: `0x${string}`;
  readonly proposerAddress: `0x${string}`;
  /**
   * The Safe nonce this payout was proposed at. The #360 fee conversion is pinned to
   * `nonce + 1` (NOT its own getNextNonce read), so it deterministically takes a
   * HIGHER nonce than the payout even if the Safe Tx Service hasn't yet reflected this
   * proposal — a same-nonce conversion could otherwise invalidate the payout. (Codex #474)
   */
  readonly nonce: number;
}

/**
 * Build the Safe api-kit for a chain. The api-kit lacks a built-in Transaction Service URL
 * for some chains (e.g. Unichain 130) and THROWS without one, so pass the explicit URL there;
 * chains it knows (Gnosis 100, Optimism 10) get undefined and keep the built-in behavior.
 */
function makeApiKit(chainId: number): SafeApiKit {
  const txServiceUrl = safeTxServiceUrl(chainId);
  return new SafeApiKit({ chainId: BigInt(chainId), ...(txServiceUrl ? { txServiceUrl } : {}) });
}

/**
 * The next free Safe nonce (counts already-queued Tx-Service txs). Exported so a caller
 * proposing MULTIPLE Safe txs in one run reads it ONCE and derives each subsequent nonce
 * locally (nonce + 1), rather than re-reading between proposals where the Tx Service may not
 * yet reflect a just-posted tx and could hand out a colliding nonce. Reuses the same
 * txService-aware api-kit construction as proposeRebateBatch. (Codex #474)
 */
export async function getNextSafeNonce(chainId: number, safeAddress: `0x${string}`): Promise<number> {
  return Number(await makeApiKit(chainId).getNextNonce(safeAddress));
}

/**
 * Submit a Safe transaction to the Safe Transaction Service queue. The proposer key
 * has zero on-chain authority — it's only known to Safe TX Service as a permitted
 * proposer for OPHIS_SAFE_ADDRESS. Execution still requires a human signer.
 */
export async function proposeRebateBatch(p: ProposeParams): Promise<ProposeResult> {
  if (p.transfers.length === 0) throw new Error('proposeRebateBatch: empty transfers list');
  const weth = WETH_BY_CHAIN[p.chainId];
  if (!weth) throw new Error(`no WETH configured for chain ${p.chainId}`);
  const multiSend = multiSendCallOnlyAddress(p.chainId);
  const calldata = buildRebateMultisend(p.transfers, weth);

  const protocolKit = await Safe.init({
    provider: p.rpcUrl,
    signer: p.proposerPrivateKey,
    safeAddress: OPHIS_SAFE_ADDRESS,
  });
  const proposerAddress = (await protocolKit.getSafeProvider().getSignerAddress()) as `0x${string}`;

  const apiKit = makeApiKit(p.chainId);
  // Use the caller-supplied nonce when given (a same-run catch-up owns the nonce: it reads
  // getNextSafeNonce ONCE and passes an explicit nonce to every proposal, so they never
  // collide even when the Tx Service has not yet reflected a just-posted proposal).
  // Otherwise fall back to the next free nonce (counts already-queued Tx-Service txs, e.g. a
  // same-run #360 conversion proposal); for the normal case that equals the on-chain nonce.
  // The affiliate / rebate batcher callers pass no nonce, so their behavior is unchanged. (Codex #474)
  const nonce = p.nonce ?? Number(await apiKit.getNextNonce(OPHIS_SAFE_ADDRESS));
  const safeTx = await protocolKit.createTransaction({
    transactions: [{ to: multiSend, value: '0', data: calldata, operation: 1 /* DELEGATECALL */ }],
    options: { nonce },
  });
  const safeTxHash = (await protocolKit.getTransactionHash(safeTx)) as `0x${string}`;
  const senderSignature = await protocolKit.signHash(safeTxHash);
  // Point of no return: everything above is local/RPC work that queues nothing.
  // The submit below may queue a proposal on the Safe Transaction Service, so the
  // caller marks the cycle 'proposing' here and not before. (Codex P2)
  await p.onBeforeSubmit?.();
  await apiKit.proposeTransaction({
    safeAddress: OPHIS_SAFE_ADDRESS,
    safeTransactionData: safeTx.data,
    safeTxHash,
    senderAddress: proposerAddress,
    senderSignature: senderSignature.data,
  });
  log.info({ safeTxHash, proposerAddress, recipientCount: p.transfers.length, nonce }, 'proposed');
  return { safeTxHash, proposerAddress, nonce };
}
