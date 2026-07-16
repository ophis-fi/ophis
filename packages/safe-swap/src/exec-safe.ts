/**
 * Optional headless executor for the buildOphisSafePresign() tx batch.
 *
 * buildOphisSafePresign() is transport-agnostic: it RETURNS the raw
 * [approve?, setPreSignature] batch and leaves execution to the curator's own
 * signing layer. This adapter is the batteries-included path for the common case
 * where an MPC / single-owner key executes directly, using @safe-global/protocol-kit.
 *
 * It builds ONE Safe transaction (MultiSendCallOnly, so the batch can only make
 * plain CALLs - never a delegatecall into the Safe), signs it with the provided
 * key, and:
 *  - executes it on-chain when the Safe threshold is 1 (the MPC / single-owner
 *    curator case), returning the on-chain tx hash; OR
 *  - when the threshold is > 1, returns the signed safeTxHash WITHOUT executing,
 *    so the caller collects the remaining co-signatures (or proposes via the Safe
 *    Transaction Service / their multisig UI) before execution.
 *
 * A Zodiac-Roles-gated curator does NOT use this adapter: the Roles module
 * executes the calls itself under the scoped role (see ./roles-preset). This
 * adapter is only imported via the "@ophis/safe-swap/exec-safe" subpath and only
 * needs @safe-global/protocol-kit (an OPTIONAL peer dependency), so the core
 * builder never pulls it in.
 */
import Safe from '@safe-global/protocol-kit';

import type { TxCall } from './order.js';

type Address = `0x${string}`;

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
  /** The on-chain tx hash, set only when the batch was executed. */
  ethTxHash?: string;
  /** True when the batch executed on-chain; false when co-signatures are still needed. */
  executed: boolean;
  /** The Safe's signature threshold. */
  threshold: number;
}

export async function executeOphisSafePresign(
  p: ExecuteOphisSafePresignParams,
): Promise<ExecuteOphisSafePresignResult> {
  if (!p.txs.length) throw new Error('executeOphisSafePresign: empty tx batch');

  const safe = await Safe.init({ provider: p.provider, signer: p.signer, safeAddress: p.safe });

  // onlyCalls => MultiSendCallOnly: the batch executes via CALL only, so no
  // delegatecall can run in the Safe's context.
  const safeTx = await safe.createTransaction({
    transactions: p.txs.map((t) => ({ to: t.to, value: t.value, data: t.data })),
    onlyCalls: true,
  });

  const safeTxHash = await safe.getTransactionHash(safeTx);
  const signed = await safe.signTransaction(safeTx);
  const threshold = await safe.getThreshold();

  // A single signer only satisfies a threshold of 1. Higher thresholds must
  // gather the remaining co-signatures before execution.
  if (threshold > 1) {
    return { safeTxHash, executed: false, threshold };
  }

  const res = await safe.executeTransaction(signed);
  return { safeTxHash, ethTxHash: res.hash, executed: true, threshold };
}
