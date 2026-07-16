/**
 * Optional headless executor for the buildOphisSafePresign() tx batch.
 *
 * buildOphisSafePresign() is transport-agnostic: it RETURNS the raw
 * [approve?, setPreSignature] batch and leaves execution to the curator's own
 * signing layer. This adapter is the batteries-included path for the common case
 * where an MPC / single-owner key executes directly, using @safe-global/protocol-kit.
 *
 * It builds ONE Safe transaction from the batch, signs it with the provided key, and:
 *  - executes it on-chain when the Safe threshold is 1 (the MPC / single-owner
 *    curator case), WAITS for the receipt, verifies the Safe did not emit
 *    ExecutionFailure (a Safe tx can mine successfully while the inner batch
 *    reverts), and only then reports executed:true with the on-chain tx hash; OR
 *  - when the threshold is > 1, returns the signed safeTxHash AND this signer's
 *    encoded signature WITHOUT executing, so the caller collects the remaining
 *    co-signatures (or proposes via the Safe Transaction Service) before execution.
 *
 * The batch is built MultiSendCallOnly (onlyCalls), so its inner operations are
 * plain CALLs - the Safe delegatecalls only the trusted MultiSendCallOnly library,
 * never an attacker-supplied target. This adapter TRUSTS the batch it is handed:
 * pass the exact output of buildOphisSafePresign (which is fully guarded - uid
 * binding, exact approve, correct relayer/settlement). Do not feed it an unvetted
 * batch from an untrusted source.
 *
 * Imported only via the "@ophis/safe-swap/exec-safe" subpath; needs
 * @safe-global/protocol-kit (an OPTIONAL peer dependency), so the core builder
 * never pulls it in. A Zodiac-Roles-gated curator uses ./roles-preset instead (the
 * Roles module executes the calls under the scoped role, not a Safe owner sig).
 */
import Safe from '@safe-global/protocol-kit';
import { keccak256, toHex } from 'viem';

import type { TxCall } from './order.js';

type Address = `0x${string}`;

// Safe emits ExecutionFailure(bytes32 txHash, uint256 payment) when the batch
// reverts INSIDE an otherwise-successful execTransaction. We must treat that as a
// failed execution, not a success.
const EXECUTION_FAILURE_TOPIC = keccak256(toHex('ExecutionFailure(bytes32,uint256)')).toLowerCase();

export interface ExecuteOphisSafePresignParams {
  /** JSON-RPC URL (or an EIP-1193 provider) for the target chain. */
  provider: string;
  /** 0x-hex private key of an owner / MPC signer for the Safe. */
  signer: string;
  /** The vault Safe (must be the batch's order.from / order.receiver). */
  safe: Address;
  /** The [approve?, setPreSignature] batch returned by buildOphisSafePresign. */
  txs: TxCall[];
}

export interface ExecuteOphisSafePresignResult {
  /** The Safe transaction hash (co-signature target for a multisig). */
  safeTxHash: string;
  /** The on-chain tx hash, set only when the batch was executed and mined OK. */
  ethTxHash?: string;
  /** True only when the batch executed AND mined without an ExecutionFailure. */
  executed: boolean;
  /** The Safe's signature threshold. */
  threshold: number;
  /** This signer's encoded signature, returned on the multisig (unexecuted) path. */
  signatures?: string;
}

interface MinimalReceipt {
  status?: number | bigint | string | null;
  logs?: { topics?: readonly string[] }[];
}

export async function executeOphisSafePresign(
  p: ExecuteOphisSafePresignParams,
): Promise<ExecuteOphisSafePresignResult> {
  if (!p.txs.length) throw new Error('executeOphisSafePresign: empty tx batch');

  const safe = await Safe.init({ provider: p.provider, signer: p.signer, safeAddress: p.safe });

  const safeTx = await safe.createTransaction({
    transactions: p.txs.map((t) => ({ to: t.to, value: t.value, data: t.data })),
    onlyCalls: true, // MultiSendCallOnly: inner ops are CALLs, no attacker delegatecall
  });

  const safeTxHash = await safe.getTransactionHash(safeTx);
  const signed = await safe.signTransaction(safeTx);
  const threshold = await safe.getThreshold();

  // A single signer only satisfies a threshold of 1. Higher thresholds must gather
  // the remaining co-signatures; return this signer's signature so the caller can.
  if (threshold > 1) {
    return { safeTxHash, executed: false, threshold, signatures: signed.encodedSignatures() };
  }

  const res = await safe.executeTransaction(signed);

  // Wait for the receipt and fail LOUDLY on a revert or a Safe ExecutionFailure -
  // executed:true must mean "mined and the batch succeeded", never just "submitted".
  const txResponse = res.transactionResponse as { wait?: () => Promise<MinimalReceipt> } | undefined;
  const receipt = await txResponse?.wait?.();
  if (receipt) {
    // Accept both viem ('success'|'reverted') and ethers (1|0) receipt shapes.
    const reverted =
      receipt.status === 'reverted' || receipt.status === 0 || receipt.status === 0n || receipt.status === '0x0';
    const innerFailure = (receipt.logs ?? []).some((l) => l.topics?.[0]?.toLowerCase() === EXECUTION_FAILURE_TOPIC);
    if (reverted || innerFailure) {
      throw new Error(
        `executeOphisSafePresign: Safe batch did not succeed (tx ${res.hash}; ${innerFailure ? 'Safe ExecutionFailure' : 'reverted'})`,
      );
    }
  }

  return { safeTxHash, ethTxHash: res.hash, executed: true, threshold };
}
