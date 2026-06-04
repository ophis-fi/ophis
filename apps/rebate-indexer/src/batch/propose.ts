import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { OPHIS_SAFE_ADDRESS, multiSendCallOnlyAddress, WETH_BY_CHAIN } from '../safe/addresses.js';
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
}

export interface ProposeResult {
  readonly safeTxHash: `0x${string}`;
  readonly proposerAddress: `0x${string}`;
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

  const safeTx = await protocolKit.createTransaction({
    transactions: [{ to: multiSend, value: '0', data: calldata, operation: 1 /* DELEGATECALL */ }],
  });
  const safeTxHash = (await protocolKit.getTransactionHash(safeTx)) as `0x${string}`;
  const senderSignature = await protocolKit.signHash(safeTxHash);

  const apiKit = new SafeApiKit({ chainId: BigInt(p.chainId) });
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
  log.info({ safeTxHash, proposerAddress, recipientCount: p.transfers.length }, 'proposed');
  return { safeTxHash, proposerAddress };
}
