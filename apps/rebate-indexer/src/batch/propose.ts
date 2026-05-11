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
